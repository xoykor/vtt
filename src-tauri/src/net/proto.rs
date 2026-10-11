//! P2P handshake protocol (pure, hermetic: no sockets here).
//!
//! Wire format is JSON with `version`, `room`, `role`:
//! `{"version":"1.0","room":"...","role":"host"}`.
//!
//! Transport policy (global constraint): critical state travels over
//! ordered TCP; ephemeral cursor/light updates travel over UDP. The host
//! is authoritative. mDNS advertises `_vtt._tcp`. Real sockets land in
//! later tasks; this module fixes versions, parsing and roles.

/// Protocol version spoken by this build.
pub const PROTOCOL_VERSION: &str = "1.0";

/// mDNS service type announced by hosts.
pub const MDNS_SERVICE: &str = "_vtt._tcp";

/// Transports: ordered TCP for state, UDP for cursor/light.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    /// Critical state: ordered, reliable (TCP).
    TcpState,
    /// Cursor/light: ephemeral, loss-tolerant (UDP).
    UdpCursor,
}

impl Channel {
    pub fn transport(&self) -> &'static str {
        match self {
            Channel::TcpState => "tcp",
            Channel::UdpCursor => "udp",
        }
    }
}

/// Role in a room. The host is authoritative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Role {
    Host,
    Guest,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Host => "host",
            Role::Guest => "guest",
        }
    }

    pub fn parse(s: &str) -> Result<Role, String> {
        match s {
            "host" => Ok(Role::Host),
            "guest" => Ok(Role::Guest),
            other => Err(format!("unknown role: {other}")),
        }
    }
}

/// Handshake payload: JSON with `version`, `room`, `role`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Handshake {
    pub version: String,
    pub room: String,
    pub role: Role,
}

/// Accept only when the peer speaks the expected version.
pub fn handshake(peer_version: &str, expected: &str) -> Result<(), String> {
    if peer_version == expected {
        Ok(())
    } else {
        Err(format!(
            "version mismatch: peer={peer_version} expected={expected}"
        ))
    }
}

/// Serialize a handshake to its JSON wire form.
pub fn encode_handshake(h: &Handshake) -> String {
    format!(
        "{{\"version\":\"{}\",\"room\":\"{}\",\"role\":\"{}\"}}",
        h.version,
        h.room,
        h.role.as_str()
    )
}

fn extract_field(json: &str, key: &str) -> Result<String, String> {
    let needle = format!("\"{key}\"");
    let start = json
        .find(needle.as_str())
        .ok_or_else(|| format!("missing field: {key}"))?;
    let rest = &json[start + needle.len()..];
    let colon = rest
        .find(':')
        .ok_or_else(|| format!("malformed field: {key}"))?;
    let value = rest[colon + 1..].trim_start();
    if !value.starts_with('"') {
        return Err(format!("malformed field: {key}"));
    }
    let end = value[1..]
        .find('"')
        .ok_or_else(|| format!("malformed field: {key}"))?;
    Ok(value[1..1 + end].to_string())
}

/// Parse and version-check a handshake from its JSON wire form.
pub fn decode_handshake(json: &str) -> Result<Handshake, String> {
    let version = extract_field(json, "version")?;
    handshake(&version, PROTOCOL_VERSION)?;
    let room = extract_field(json, "room")?;
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    let role = Role::parse(&extract_field(json, "role")?)?;
    Ok(Handshake {
        version,
        room,
        role,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_fields() {
        let h = Handshake {
            version: PROTOCOL_VERSION.to_string(),
            room: "room-7000".to_string(),
            role: Role::Host,
        };
        let back = decode_handshake(&encode_handshake(&h)).unwrap();
        assert_eq!(back, h);
    }

    #[test]
    fn decode_rejects_stale_version() {
        let json = r#"{"version":"0.9","room":"r","role":"guest"}"#;
        assert!(decode_handshake(json).is_err());
    }

    #[test]
    fn channels_split_state_and_cursor() {
        assert_eq!(Channel::TcpState.transport(), "tcp");
        assert_eq!(Channel::UdpCursor.transport(), "udp");
    }
}
