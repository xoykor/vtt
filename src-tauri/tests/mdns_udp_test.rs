//! Task 6 (fase 3): mDNS-style discovery + UDP cursor over loopback.
//!
//! * cursor `encode`/`decode` round-trips (incl. escaping) and rejects
//!   malformed / non-finite payloads fail-closed;
//! * `announce(room, port)` validates inputs; `announce` -> `discover`
//!   finds the room on loopback (discover listens first, announce repeats
//!   because UDP is lossy);
//! * a cursor datagram arrives on loopback with sender-side retry
//!   (best-effort: no delivery guarantee, no handshake).
//!
//! Only ONE test here binds the fixed discovery port (`DISCOVERY_PORT`):
//! Rust runs tests in one binary on parallel threads, so two concurrent
//! `discover()` calls would race on `bind`. All other tests use ephemeral
//! ports (`127.0.0.1:0`) or pure encode/decode.

use std::time::Duration;
use vtt_tauri::net::mdns::{DISCOVERY_PORT, announce, discover};
use vtt_tauri::net::udp::{
    CursorMsg, decode_cursor, encode_cursor, recv_cursor_timeout, send_cursor,
};
use vtt_tauri::net::{MDNS_SERVICE, PROTOCOL_VERSION};

#[test]
fn cursor_roundtrip_preserves_fields() {
    let msg = CursorMsg {
        room: "room-7000".to_string(),
        id: "p1".to_string(),
        x: 12.5,
        y: -3.25,
    };
    let back = decode_cursor(&encode_cursor(&msg)).expect("valid");
    assert_eq!(back, msg);
}

#[test]
fn cursor_roundtrip_escapes_quotes_backslashes_and_unicode() {
    let msg = CursorMsg {
        room: "weird \"room\" \\ é".to_string(),
        id: "guest \"1\" \\ ünï".to_string(),
        x: 0.1,
        y: 100.75,
    };
    let wire = encode_cursor(&msg);
    assert!(wire.contains("\\\"room\\\""), "got: {wire}");
    let back = decode_cursor(&wire).expect("valid");
    assert_eq!(back, msg);
    assert_eq!(back.x, 0.1);
    assert_eq!(back.y, 100.75);
}

#[test]
fn cursor_rejects_malformed_wrong_types_and_non_finite() {
    for (bad, want) in [
        ("not json", "malformed"),
        ("", "malformed"),
        ("[1,2]", "malformed"),
        (r#"{"room":"r","id":"p","x":1}"#, "missing field: y"),
        (r#"{"room":"r","id":"p","y":2}"#, "missing field: x"),
        (r#"{"room":"r","x":1,"y":2}"#, "missing field: id"),
        (r#"{"room":"","id":"p","x":1,"y":2}"#, "missing field: room"),
        (r#"{"room":"r","id":"","x":1,"y":2}"#, "missing field: id"),
        (
            r#"{"room":"r","id":"p","x":"1","y":2}"#,
            "malformed cursor json",
        ),
        (
            r#"{"room":"r","id":"p","x":1,"y":NaN}"#,
            "non-finite",
        ),
        (
            r#"{"room":"r","id":"p","x":inf,"y":2}"#,
            "non-finite",
        ),
        (
            "{\"room\":\"r\",\"id\":\"p\",\"x\":1,\"y\":2}trailing",
            "trailing",
        ),
    ] {
        let err = decode_cursor(bad).expect_err("must fail");
        assert!(err.contains(want), "input {bad:?} gave: {err}");
    }
}

#[test]
fn announce_rejects_empty_room_and_port_zero_without_panicking() {
    let err = announce("", 7000).unwrap_err();
    assert!(err.contains("missing field: room"), "got: {err}");
    let err = announce("room-7000", 0).unwrap_err();
    assert!(err.contains("invalid port"), "got: {err}");
}

#[test]
fn announce_discover_loopback_finds_the_room() {
    // Unique room so stray datagrams from other runs cannot fake a pass.
    let room = format!("room-mdns-{}-{}", std::process::id(), DISCOVERY_PORT);
    let tcp_port: u16 = 17893;
    let wanted = room.clone();

    // `discover` must already listen: UDP has no backlog, so a datagram
    // sent before `bind` is lost. Announce repeats to survive loss.
    let server = std::thread::spawn(move || discover(Duration::from_secs(3)));
    std::thread::sleep(Duration::from_millis(150));
    for _ in 0..5 {
        announce(&wanted, tcp_port).expect("announce loopback");
        std::thread::sleep(Duration::from_millis(100));
    }
    let found = server
        .join()
        .expect("discover thread")
        .expect("discover ok");

    let hit = found.iter().find(|d| d.room == room);
    assert!(
        hit.is_some(),
        "room {room:?} not discovered in: {found:?}"
    );
    let hit = hit.expect("found");
    assert_eq!(hit.port, tcp_port);
    assert_eq!(hit.version, PROTOCOL_VERSION);
    assert!(
        hit.addr.contains("127.0.0.1"),
        "loopback announce must arrive from 127.0.0.1, got: {}",
        hit.addr
    );
    // Announcements are tagged with the mDNS service type.
    let _ = MDNS_SERVICE;
}

#[tokio::test]
async fn cursor_arrives_on_loopback_with_sender_retry() {
    use tokio::net::UdpSocket;

    let rx = UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("bind rx");
    let rx_addr = rx.local_addr().expect("rx addr");
    let tx = UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("bind tx");
    let msg = CursorMsg {
        room: "room-7000".to_string(),
        id: "guest-1".to_string(),
        x: 320.5,
        y: 200.25,
    };

    // Best-effort: no ACK, no handshake — the sender just repeats until
    // the test's receive deadline. Absence after retries is Ok-shaped
    // `Err`, never a hang (capped by `recv_cursor_timeout`).
    let mut got: Option<CursorMsg> = None;
    for _ in 0..20 {
        send_cursor(&tx, rx_addr, &msg)
            .await
            .expect("udp send loopback");
        match recv_cursor_timeout(&rx, Duration::from_millis(100)).await {
            Ok(m) => {
                got = Some(m);
                break;
            }
            Err(_) => continue,
        }
    }
    let got = got.expect("cursor must arrive on loopback after retries");
    assert_eq!(got, msg);
}
