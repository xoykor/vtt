//! P2P room API consumed by Tasks 3-6.
//!
//! Hermetic and transport-free: validates addresses, builds room/peer
//! descriptors and applies state deltas as pure functions. The host is
//! authoritative; critical state goes over [`Channel::TcpState`], cursor
//! updates over [`Channel::UdpCursor`].

pub mod proto;
pub mod tcp;

pub use proto::{
    Channel, Handshake, MDNS_SERVICE, PROTOCOL_VERSION,
    PROTOCOL_VERSION_MAJOR, Role, decode_handshake, encode_handshake,
    handshake,
};
use std::collections::BTreeMap;

/// A hosted room: deterministic id bound to the given port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomInfo {
    pub room: String,
    pub port: u16,
    pub version: String,
}

/// A remote peer joined via [`join_room`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub ip: String,
    pub port: u16,
    pub role: Role,
}

/// A state delta: key upserts plus key removals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delta {
    pub upsert: Vec<(String, String)>,
    pub remove: Vec<String>,
}

fn check_port(port: u16) -> Result<u16, String> {
    if port == 0 {
        return Err(format!(
            "invalid port: {port} (use 1-65535; if peers cannot connect over the internet, host via a ZeroTier/Radmin/Hamachi VPN and share that IP)"
        ));
    }
    Ok(port)
}

const VPN_HINT: &str =
    "if peers cannot connect over the internet, host via a ZeroTier/Radmin/Hamachi VPN and share that IP";

fn check_ipv4(ip: &str) -> Result<(), String> {
    let parts: Vec<&str> = ip.split('.').collect();
    if parts.len() != 4 {
        return Err(format!("invalid ip: {ip} ({VPN_HINT})"));
    }
    for part in &parts {
        if part.is_empty() || (part.len() > 1 && part.starts_with('0')) {
            return Err(format!("invalid ip: {ip} ({VPN_HINT})"));
        }
        match part.parse::<u8>() {
            Ok(_) => {}
            Err(_) => return Err(format!("invalid ip: {ip} ({VPN_HINT})")),
        }
    }
    Ok(())
}

/// Host a room on `port`. The room id is deterministic (`room-<port>`)
/// so tests stay hermetic; unique ids/transport land in later tasks.
/// Returns `Err` on port 0 instead of panicking (fail-closed like `join_room`).
pub fn create_room(port: u16) -> Result<RoomInfo, String> {
    let port = check_port(port)?;
    Ok(RoomInfo {
        room: format!("room-{port}"),
        port,
        version: PROTOCOL_VERSION.to_string(),
    })
}

/// Join the room hosted at `ip:port` as guest.
/// Errors include the `ip:port` and suggest a ZeroTier/Radmin/Hamachi VPN when the address is invalid or unreachable.
pub fn join_room(ip: &str, port: u16) -> Result<Peer, String> {
    check_ipv4(ip).map_err(|e| format!("{e} [join {ip}:{port}]"))?;
    let port = check_port(port).map_err(|e| format!("{e} [join {ip}:{port}]"))?;
    Ok(Peer {
        ip: ip.to_string(),
        port,
        role: Role::Guest,
    })
}

/// Pure state transition: returns the state with `delta` applied,
/// leaving the input untouched for Tasks 3-6 to consume.
/// Remove-wins: upserts apply first, then removes, so a key in both is deleted.
/// NOTE: `Delta` here has required `upsert`/`remove` vecs while the TS mirror
/// (`src/net/peer.ts`) uses optional fields; the future FFI bridge must adapt between the two shapes.
pub fn apply_delta(
    state: &BTreeMap<String, String>,
    delta: &Delta,
) -> BTreeMap<String, String> {
    let mut next = state.clone();
    for (key, value) in &delta.upsert {
        next.insert(key.clone(), value.clone());
    }
    for key in &delta.remove {
        next.remove(key);
    }
    next
}
