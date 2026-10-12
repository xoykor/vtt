//! Tauri invoke bridge with the real room (Fase 2, Task 4).
//!
//! Consumes `startApp`'s shell (T1) on the frontend, the invoke handler
//! plumbing (T2) and `serve/connect_handshake` (T3) on the backend:
//! * `create_room(port)` hosts a real room descriptor via
//!   [`crate::net::create_room`];
//! * `join_room(ip, port)` validates like [`crate::net::join_room`] and then
//!   dials the host over real TCP ([`crate::net::tcp::connect_handshake`])
//!   with a fail-closed timeout, returning the host's room reply;
//! * `push_delta(delta)` / `get_snapshot()` share the host-authoritative
//!   state ([`crate::net::apply_delta`] + [`crate::save`]) across invokes.
//!
//! Boundary rule (no new deps): every `#[tauri::command]` takes and returns
//! only `String`/`u16`/`()` — JSON travels as strings through the existing
//! std-only codecs (`encode_room_info`, `decode_delta`, `export_json`), so
//! the default-off `tauri-app` feature keeps compiling in CI while default
//! `cargo test` never touches `tauri`. The pure core below (`RoomStore`,
//! [`host_room`], [`validate_join`], [`join_live`], [`RoomStore::push_delta_json`])
//! is always compiled and covered by `tests/commands_test.rs` via
//! `use vtt_tauri::...` (no `#[path]` shim).
//!
//! Rejection policy: like T3's handshake, a refused/unreachable host or a
//! version mismatch yields `Err` — the guest observes EOF/timeout, never a
//! hang. All join errors surface `ip:port` plus the ZeroTier/Radmin/Hamachi
//! VPN hint, mirroring [`crate::net::join_room`].

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::time::Duration;

use super::net::tcp::{connect_handshake, decode_delta};
use super::net::{
    apply_delta, create_room as net_create_room, join_room as net_join_room,
    Delta, Peer, RoomInfo,
};
use super::save::{export_json, snapshot, GameSave, SAVE_VERSION};
#[cfg(feature = "tauri-app")]
use super::net::tcp::encode_room_info;

/// Fail-closed cap for the live TCP dial + handshake in [`join_live`].
pub const JOIN_TIMEOUT_SECS: u64 = 10;

const VPN_HINT: &str = "if peers cannot connect over the internet, host via a ZeroTier/Radmin/Hamachi VPN and share that IP";

/// Host-authoritative room: descriptor plus the full `RoomState` partition.
/// Deltas apply via [`apply_delta`] (remove-wins); snapshots wholesale via
/// [`snapshot`] so rejoining guests never duplicate tokens.
#[derive(Debug, Clone)]
pub struct RoomStore {
    pub info: RoomInfo,
    pub state: BTreeMap<String, String>,
}

impl RoomStore {
    /// Host a room on `port` with empty state (`Err` on port 0).
    pub fn host(port: u16) -> Result<RoomStore, String> {
        Ok(RoomStore {
            info: net_create_room(port)?,
            state: BTreeMap::new(),
        })
    }

    /// Apply a parsed delta to the hosted state (remove-wins).
    pub fn push_delta(&mut self, delta: &Delta) {
        self.state = apply_delta(&self.state, delta);
    }

    /// Parse `delta_json` (`{"upsert":{...},"remove":[...]}` wire form) and
    /// apply it; returns the new key count.
    pub fn push_delta_json(&mut self, delta_json: &str) -> Result<usize, String> {
        let delta = decode_delta(delta_json)?;
        self.push_delta(&delta);
        Ok(self.state.len())
    }

    /// Full snapshot the host diffuses on (re)join.
    pub fn snapshot(&self) -> GameSave {
        snapshot(&self.info.room, SAVE_VERSION, &self.state)
    }

    /// Snapshot as its JSON export form (what `get_snapshot` returns).
    pub fn snapshot_json(&self) -> String {
        export_json(&self.snapshot())
    }
}

/// Pure host descriptor (no sockets): deterministic `room-<port>`.
pub fn host_room(port: u16) -> Result<RoomInfo, String> {
    net_create_room(port)
}

/// Pure guest address validation (no sockets): `Err` carries `ip:port` plus
/// the ZeroTier/Radmin/Hamachi VPN hint.
pub fn validate_join(ip: &str, port: u16) -> Result<Peer, String> {
    net_join_room(ip, port)
}

/// Live join over real TCP (consumes T3): validate `ip`/`port`, dial the
/// host and run the version-gated handshake, all fail-closed after
/// [`JOIN_TIMEOUT_SECS`]. Version mismatches close without a typed error
/// frame — the guest observes EOF (`tcp read failed`), which IS the
/// rejection signal; both sides return `Err`, never panic. Errors surface
/// `ip:port` plus the VPN hint.
pub async fn join_live(ip: &str, port: u16) -> Result<RoomInfo, String> {
    let peer = net_join_room(ip, port)?;
    let addr: SocketAddr = format!("{}:{}", peer.ip, peer.port)
        .parse()
        .map_err(|e| {
            format!(
                "invalid addr: {}:{} ({e}) [{ip}:{port}] ({VPN_HINT})",
                peer.ip, peer.port
            )
        })?;
    tokio::time::timeout(
        Duration::from_secs(JOIN_TIMEOUT_SECS),
        connect_handshake(addr),
    )
    .await
    .map_err(|_| {
        format!(
            "join timed out after {JOIN_TIMEOUT_SECS}s [{ip}:{port}] ({VPN_HINT})"
        )
    })?
    .map_err(|e| format!("{e} [join {ip}:{port}] ({VPN_HINT})"))
}

/// Managed host state for the Tauri commands below (one room per window).
#[cfg(feature = "tauri-app")]
pub struct HostState(pub std::sync::Mutex<Option<RoomStore>>);

#[cfg(feature = "tauri-app")]
impl Default for HostState {
    fn default() -> HostState {
        HostState(std::sync::Mutex::new(None))
    }
}

#[cfg(feature = "tauri-app")]
fn lock_host(
    host: &std::sync::Mutex<Option<RoomStore>>,
) -> Result<std::sync::MutexGuard<'_, Option<RoomStore>>, String> {
    host.lock().map_err(|_| "room store poisoned".to_string())
}

#[cfg(feature = "tauri-app")]
fn require_host<'a>(
    guard: &'a mut std::sync::MutexGuard<'_, Option<RoomStore>>,
) -> Result<&'a mut RoomStore, String> {
    guard
        .as_mut()
        .ok_or_else(|| "no room hosted yet (call create_room first)".to_string())
}

/// Host a real room: `invoke("create_room", { port })` → room-info JSON.
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn create_room(
    port: u16,
    host: tauri::State<'_, HostState>,
) -> Result<String, String> {
    let store = RoomStore::host(port)?;
    let reply = encode_room_info(&store.info);
    *lock_host(&host.0)? = Some(store);
    Ok(reply)
}

/// Join the room at `ip:port` over real TCP: `invoke("join_room",
/// `{ ip, port })` → host's room-info JSON. Validation + dial errors carry
/// `ip:port` and the VPN hint.
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn join_room(ip: String, port: u16) -> Result<String, String> {
    join_live(&ip, port)
        .await
        .map(|info| encode_room_info(&info))
}

/// Apply a delta to the hosted state: `invoke("push_delta", { delta })`
/// with `delta` as `{"upsert":{...},"remove":[...]}` JSON → updated
/// snapshot JSON.
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn push_delta(
    delta: String,
    host: tauri::State<'_, HostState>,
) -> Result<String, String> {
    let parsed = decode_delta(&delta)?;
    let mut guard = lock_host(&host.0)?;
    let store = require_host(&mut guard)?;
    store.push_delta(&parsed);
    Ok(store.snapshot_json())
}

/// Full host snapshot: `invoke("get_snapshot")` → save JSON
/// (`{"version","room","state"}`).
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn get_snapshot(host: tauri::State<'_, HostState>) -> Result<String, String> {
    let guard = lock_host(&host.0)?;
    let store = guard
        .as_ref()
        .ok_or_else(|| "no room hosted yet (call create_room first)".to_string())?;
    Ok(store.snapshot_json())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_uses_given_port_and_rejects_zero() {
        let store = RoomStore::host(7000).expect("valid port");
        assert_eq!(store.info.room, "room-7000");
        assert_eq!(store.info.port, 7000);
        assert!(RoomStore::host(0).is_err());
    }

    #[test]
    fn delta_json_applies_remove_wins_and_snapshot_roundtrips() {
        let mut store = RoomStore::host(7000).expect("host");
        let n = store
            .push_delta_json(
                r#"{"upsert":{"token:dm":"{\"id\":\"dm\"}","a":"1"},"remove":[]}"#,
            )
            .expect("valid delta");
        assert_eq!(n, 2);
        let n = store
            .push_delta_json(r#"{"upsert":{"a":"2"},"remove":["token:dm"]}"#)
            .expect("valid delta");
        assert_eq!(n, 1);
        let snap = store.snapshot();
        assert_eq!(snap.room, "room-7000");
        assert_eq!(snap.state.get("a"), Some(&"2".to_string()));
        assert!(!snap.state.contains_key("token:dm"));
        let back = super::super::save::import_json(&store.snapshot_json())
            .expect("snapshot json parses");
        assert_eq!(back, snap);
    }

    #[test]
    fn delta_json_rejects_malformed() {
        let mut store = RoomStore::host(7000).expect("host");
        assert!(store.push_delta_json("not json").is_err());
    }

    #[test]
    fn validate_join_surfaces_ip_and_vpn_hint() {
        let err = validate_join("999.999.1.1", 7000).expect_err("bad ip");
        assert!(err.contains("999.999.1.1"), "got: {err}");
        assert!(err.contains("7000"), "got: {err}");
        assert!(err.contains("ZeroTier"), "got: {err}");
    }
}
