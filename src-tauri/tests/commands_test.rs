//! Task 4 bridge: invoke commands over the real room (consumes T2/T3).
//!
//! Hermetic loopback only (`127.0.0.1:0`, ephemeral ports): hosting,
//! validation, delta push and snapshot stay pure, while `join_live` dials a
//! real `serve_once` host and proves the guest gets the room reply — or a
//! fail-closed `Err` (EOF/timeout) carrying `ip:port` and the VPN hint.

use std::time::Duration;
use tokio::net::TcpListener;
use vtt_tauri::commands::{RoomStore, host_room, join_live, validate_join};
use vtt_tauri::net::tcp::serve_once;
use vtt_tauri::save::import_json;

#[test]
fn host_room_uses_given_port_and_rejects_zero() {
    let info = host_room(7000).expect("valid port");
    assert_eq!(info.room, "room-7000");
    assert_eq!(info.port, 7000);
    assert_eq!(info.version, "1.0");
    let err = host_room(0).expect_err("port 0 must fail");
    assert!(err.contains("invalid port"), "got: {err}");
}

#[test]
fn validate_join_error_includes_ip_port_and_vpn_hint() {
    let err = validate_join("999.999.1.1", 7000).expect_err("bad ip");
    assert!(err.contains("999.999.1.1"), "got: {err}");
    assert!(err.contains("7000"), "got: {err}");
    assert!(err.contains("ZeroTier"), "got: {err}");
    let peer = validate_join("127.0.0.1", 7000).expect("valid addr");
    assert_eq!(peer.ip, "127.0.0.1");
    assert_eq!(peer.port, 7000);
}

#[test]
fn push_delta_and_snapshot_share_host_state() {
    let mut store = RoomStore::host(7000).expect("host");
    let n = store
        .push_delta_json(r#"{"upsert":{"token:dm":"{\"id\":\"dm\"}"},"remove":[]}"#)
        .expect("valid delta");
    assert_eq!(n, 1);
    let json = store.snapshot_json();
    let back = import_json(&json).expect("snapshot parses");
    assert_eq!(back.room, "room-7000");
    assert_eq!(back.state.len(), 1);
    assert!(store.push_delta_json("not json").is_err());
}

/// Live loopback: `join_live` dials a real `serve_once` host and returns
/// its room reply. Capped well above the 10 s join timeout so a hang fails
/// the test instead of the suite.
async fn live_roundtrip() -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(30), live_roundtrip_inner())
        .await
        .map_err(|_| "live join test timed out".to_string())?
}

async fn live_roundtrip_inner() -> Result<String, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?
        .port();
    let server = tokio::spawn(async move { serve_once(listener).await });
    let info = join_live("127.0.0.1", port).await;
    let served = server
        .await
        .map_err(|e| format!("server join failed: {e}"))?;
    let served = served?;
    let info = info?;
    assert_eq!(info.room, served.room);
    assert_eq!(info.port, port);
    Ok(info.room)
}

#[tokio::test]
async fn join_live_returns_host_room_over_tcp() {
    let room = live_roundtrip().await.expect("loopback join");
    assert!(!room.is_empty());
}

#[tokio::test]
async fn join_live_rejects_bad_ip_without_dialing() {
    let err = join_live("999.999.1.1", 7000)
        .await
        .expect_err("bad ip must fail");
    assert!(err.contains("999.999.1.1"), "got: {err}");
    assert!(err.contains("7000"), "got: {err}");
    assert!(err.contains("ZeroTier"), "got: {err}");
}

#[tokio::test]
async fn join_live_refused_surfaces_addr_and_hint() {
    // Ephemeral port bound then dropped: nothing listens → refused fast.
    let port = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind")
        .local_addr()
        .expect("addr")
        .port();
    let err = tokio::time::timeout(
        Duration::from_secs(30),
        join_live("127.0.0.1", port),
    )
    .await
    .map_err(|_| "test timed out".to_string())
    .expect("no test hang")
    .expect_err("refused must fail");
    assert!(err.contains("127.0.0.1"), "got: {err}");
    assert!(err.contains(&port.to_string()), "got: {err}");
    assert!(err.contains("ZeroTier"), "got: {err}");
}
