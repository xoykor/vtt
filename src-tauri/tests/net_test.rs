#[allow(dead_code)]
#[path = "../src/lib.rs"]
mod main;
use main::net::{apply_delta, create_room, handshake, join_room};

#[test]
fn handshake_rejects_version_mismatch() {
    let res = handshake("0.9", "1.0");
    assert!(res.is_err());
}

#[test]
fn handshake_accepts_matching_version() {
    assert!(handshake("1.0", "1.0").is_ok());
}

#[test]
fn create_room_uses_given_port() {
    let info = create_room(7000).expect("valid port");
    assert_eq!(info.port, 7000);
    assert_eq!(info.version, "1.0");
    assert!(!info.room.is_empty());
}

#[test]
fn create_room_rejects_port_zero_without_panicking() {
    let err = create_room(0).unwrap_err();
    assert!(err.contains("invalid port"), "got: {err}");
    assert!(err.contains('0'), "got: {err}");
}

#[test]
fn join_room_rejects_bad_ip() {
    assert!(join_room("999.999.1.1", 7000).is_err());
}

#[test]
fn join_room_error_includes_ip_port_and_vpn_hint() {
    let err = join_room("999.999.1.1", 7000).unwrap_err();
    assert!(err.contains("999.999.1.1"), "got: {err}");
    assert!(err.contains("7000"), "got: {err}");
    assert!(err.contains("ZeroTier"), "got: {err}");
    assert!(err.contains("Radmin"), "got: {err}");
    assert!(err.contains("Hamachi"), "got: {err}");
    let port_err = join_room("127.0.0.1", 0).unwrap_err();
    assert!(port_err.contains("127.0.0.1"), "got: {port_err}");
    assert!(port_err.contains("ZeroTier"), "got: {port_err}");
}

#[test]
fn join_room_accepts_valid_addr() {
    let peer = join_room("127.0.0.1", 7000).expect("valid addr");
    assert_eq!(peer.ip, "127.0.0.1");
    assert_eq!(peer.port, 7000);
}

#[test]
fn apply_delta_upserts_and_removes() {
    let mut state = std::collections::BTreeMap::new();
    state.insert("a".to_string(), "1".to_string());
    state.insert("b".to_string(), "2".to_string());
    let delta = main::net::Delta {
        upsert: vec![("b".to_string(), "3".to_string())],
        remove: vec!["a".to_string()],
    };
    let next = apply_delta(&state, &delta);
    assert_eq!(next.get("b"), Some(&"3".to_string()));
    assert!(!next.contains_key("a"));
    // Pure: input untouched.
    assert_eq!(state.get("b"), Some(&"2".to_string()));
}

#[test]
fn apply_delta_is_remove_wins() {
    let mut state = std::collections::BTreeMap::new();
    state.insert("a".to_string(), "1".to_string());
    let delta = main::net::Delta {
        upsert: vec![("a".to_string(), "2".to_string())],
        remove: vec!["a".to_string()],
    };
    let next = apply_delta(&state, &delta);
    assert!(!next.contains_key("a"));
}
