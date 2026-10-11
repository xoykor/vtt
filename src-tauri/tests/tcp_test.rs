//! Task 3 smoke: real TCP handshake over loopback (consumed by Task 6).
//!
//! Binds `127.0.0.1:0` (ephemeral port, no fixed ports). The host accepts
//! one connection, validates the handshake version and replies with
//! `RoomInfo`; stale versions are rejected with `Err`, never panicked.

#[allow(dead_code)]
#[path = "../src/lib.rs"]
mod main;

use main::net::tcp::{
    connect_handshake, connect_with_handshake, recv_delta, recv_snapshot,
    send_delta, send_snapshot, serve_once,
};
use main::net::{Delta, Handshake, RoomInfo, Role, PROTOCOL_VERSION};
use main::save::{GameSave, SAVE_VERSION, snapshot};
use std::collections::BTreeMap;
use std::time::Duration;
use tokio::net::{TcpListener, TcpStream};

/// Full loopback round-trip for `version`: bind an ephemeral port, serve
/// one handshake, connect the guest. `Ok` only when both sides accept;
/// `Err` when either side rejects (e.g. version mismatch).
async fn roundtrip_handshake(
    version: &str,
) -> Result<(Handshake, RoomInfo), String> {
    tokio::time::timeout(Duration::from_secs(10), roundtrip_inner(version))
        .await
        .map_err(|_| "loopback roundtrip timed out".to_string())?
}

async fn roundtrip_inner(
    version: &str,
) -> Result<(Handshake, RoomInfo), String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("bind failed: {e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("local_addr failed: {e}"))?;
    let server = tokio::spawn(async move { serve_once(listener).await });
    let guest = Handshake {
        version: version.to_string(),
        room: "room-loopback".to_string(),
        role: Role::Guest,
    };
    let room = connect_with_handshake(addr, &guest).await;
    let served = server
        .await
        .map_err(|e| format!("server join failed: {e}"))?;
    Ok((served?, room?))
}

#[tokio::test]
async fn loopback_rejects_version_mismatch() {
    let res = roundtrip_handshake("0.9").await;
    assert!(res.is_err());
}

#[tokio::test]
async fn loopback_accepts_matching_version() {
    let (served, room) = roundtrip_handshake(PROTOCOL_VERSION)
        .await
        .expect("matching version must round-trip");
    assert_eq!(served.version, PROTOCOL_VERSION);
    assert_eq!(served.room, "room-loopback");
    assert_eq!(served.role, Role::Guest);
    assert_eq!(room.version, PROTOCOL_VERSION);
    assert_eq!(room.room, "room-loopback");
    assert_ne!(room.port, 0);
}

#[tokio::test]
async fn connect_handshake_returns_room_info() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let server = tokio::spawn(async move { serve_once(listener).await });
    let room = connect_handshake(addr).await.expect("handshake");
    let served = server.await.expect("join").expect("serve");
    assert_eq!(room.version, PROTOCOL_VERSION);
    assert_eq!(room.room, served.room);
    assert_eq!(room.port, addr.port());
}

#[tokio::test]
async fn snapshot_and_delta_travel_over_tcp() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let mut state = BTreeMap::new();
    state.insert("dm".to_string(), "{\"id\":\"dm\"}".to_string());
    let save: GameSave = snapshot("room-loopback", SAVE_VERSION, &state);
    let delta = Delta {
        upsert: vec![("p1".to_string(), "v1".to_string())],
        remove: vec!["dm".to_string()],
    };
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|e| format!("accept failed: {e}"))?;
        let got_save = recv_snapshot(&mut stream).await?;
        let got_delta = recv_delta(&mut stream).await?;
        Ok::<_, String>((got_save, got_delta))
    });
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    send_snapshot(&mut stream, &save)
        .await
        .expect("send snapshot");
    send_delta(&mut stream, &delta).await.expect("send delta");
    let (got_save, got_delta) = server.await.expect("join").expect("serve");
    assert_eq!(got_save, save);
    assert_eq!(got_delta, delta);
    // Guest applies the delta on top of the snapshot: remove-wins.
    let next = main::net::apply_delta(&got_save.state, &got_delta);
    assert_eq!(next.get("p1"), Some(&"v1".to_string()));
    assert!(!next.contains_key("dm"));
}
