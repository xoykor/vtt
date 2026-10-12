//! Room discovery: announce + scan for hosted rooms.
//!
//! ## Transport: UDP broadcast, NOT real mDNS (documented limitation)
//!
//! Real mDNS (RFC 6762: multicast `224.0.0.251:5353`, DNS-record
//! encoding, continuous `mdns-sd`-style browsing) needs the `mdns-sd`
//! crate. That dependency was deliberately NOT added: the dev sandbox
//! cannot reliably resolve crates.io, and multicast rarely survives
//! sandboxed CI anyway, which would make the loopback test flaky.
//! Instead [`announce`] sends a small JSON datagram to the loopback
//! address (reliable: backs the `announce` -> [`discover`] test) AND to
//! the LAN broadcast address (best-effort: reaches same-subnet peers,
//! like a poor-man's beacon), while [`discover`] listens on
//! [`DISCOVERY_PORT`] and collects beacons for a bounded `timeout`.
//!
//! What this means in practice:
//!
//! * same-machine and same-subnet discovery work with zero
//!   configuration; cross-subnet / internet peers must still join via
//!   manual `ip:port` ([`super::join_room`], which already hints at
//!   ZeroTier/Radmin/Hamachi VPNs for exactly this reason);
//! * beacons carry [`MDNS_SERVICE`] (`_vtt._tcp`) and the
//!   [`PROTOCOL_VERSION`], so only same-service, same-version rooms
//!   match — foreign beacons on the port are ignored, never an error;
//! * UPGRADE PATH: drop in `mdns-sd` (`ServiceDaemon::register` for
//!   announce, `browse` for discover, service type [`MDNS_SERVICE`])
//!   and keep these function signatures plus the JSON payload shape;
//!   the `discover` timeout maps to the browse window.
//!
//! Payload (JSON, std-only like [`super::proto`]):
//! `{"version":"1.0","service":"_vtt._tcp","room":"...","port":7000}`.
//!
//! Failure policy: every fallible step maps errors to `String` — no
//! `.expect`/`.unwrap`/panics on any network or parse path. `discover`
//! always returns within `timeout + epsilon`, even with zero beacons
//! (empty `Vec`, not an error: silence is a normal outcome).
//!
//! Port-sharing note: [`discover`] binds the fixed [`DISCOVERY_PORT`],
//! so at most ONE `discover` call may run per machine at a time (a
//! second concurrent bind fails fail-closed). Tests must respect this:
//! keep a single discover-based test per binary.

use super::{MDNS_SERVICE, PROTOCOL_VERSION, handshake};
use std::net::UdpSocket;
use std::time::{Duration, Instant};

/// UDP port beacons are sent to and discovered on. Fixed by design —
/// like mDNS's `5353`, both sides must rendezvous without prior
/// coordination. Chosen outside the room-port range used in tests.
pub const DISCOVERY_PORT: u16 = 54735;

/// Loopback destination: reliable delivery for same-machine discovery
/// (and the loopback test). Send failures here ARE errors.
const DISCOVERY_LOOPBACK: &str = "127.0.0.1";

/// LAN broadcast destination: same-subnet discovery without multicast.
/// Best-effort — send failures here are swallowed (sandboxed CI often
/// has no broadcast route; loopback still works).
const DISCOVERY_BROADCAST: &str = "255.255.255.255";

/// Slice between beacon reads while collecting in [`discover`].
const READ_SLICE: Duration = Duration::from_millis(150);

/// A room beacon heard during [`discover`]: the room id, the sender's
/// IP (`addr`), the room's TCP `port` (connect there via
/// [`super::tcp::connect_handshake`]) and the speaker's `version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredRoom {
    pub room: String,
    pub addr: String,
    pub port: u16,
    pub version: String,
}

/// Announce `room` (hosted for TCP on `tcp_port`) to the local machine
/// and LAN. Repeats are cheap and expected — UDP has no backlog, so a
/// beacon sent before any listener binds is lost; callers (and the
/// integration test) send several while the scanner listens.
///
/// `Ok` means the loopback beacon left the socket, NOT that anyone
/// heard it. Empty `room` and port `0` are `Err` (fail-closed, like
/// [`super::create_room`]).
pub fn announce(room: &str, tcp_port: u16) -> Result<(), String> {
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    if tcp_port == 0 {
        return Err(format!(
            "invalid port: {tcp_port} (use 1-65535)"
        ));
    }
    let payload = encode_announcement(room, tcp_port).into_bytes();
    let sock = UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| format!("discovery announce failed: {e}"))?;
    // Loopback first: reliable, and its errors are real (no route to
    // localhost means the machine's network is broken).
    let loopback = format!("{DISCOVERY_LOOPBACK}:{DISCOVERY_PORT}");
    sock.send_to(&payload, loopback.as_str())
        .map_err(|e| format!("discovery announce failed: {e}"))?;
    // LAN broadcast: best-effort, failures swallowed (no broadcast
    // route in containers/CI is normal, not an error).
    let _ = sock.set_broadcast(true);
    let broadcast = format!("{DISCOVERY_BROADCAST}:{DISCOVERY_PORT}");
    let _ = sock.send_to(&payload, broadcast.as_str());
    Ok(())
}

/// Listen on [`DISCOVERY_PORT`] for `timeout` and return every distinct
/// same-service, same-version room heard. Foreign-version beacons,
/// foreign-service packets and malformed datagrams are skipped, never
/// errors. Zero beacons yields `Ok(vec![])`: silence is normal.
///
/// Dedupe key is (`addr`, `port`, `room`); result order is first-heard.
pub fn discover(timeout: Duration) -> Result<Vec<DiscoveredRoom>, String> {
    let sock = UdpSocket::bind(format!("0.0.0.0:{DISCOVERY_PORT}"))
        .map_err(|e| {
            format!("discovery listen failed on port {DISCOVERY_PORT}: {e}")
        })?;
    sock.set_read_timeout(Some(READ_SLICE))
        .map_err(|e| format!("discovery listen failed: {e}"))?;
    let deadline = Instant::now() + timeout;
    let mut found: Vec<DiscoveredRoom> = Vec::new();
    let mut buf = vec![0u8; 2048];
    while Instant::now() < deadline {
        match sock.recv_from(&mut buf) {
            Ok((n, peer)) => {
                let text = match std::str::from_utf8(&buf[..n]) {
                    Ok(t) => t,
                    Err(_) => continue, // not our beacon: skip
                };
                let entry = match decode_announcement(text) {
                    Ok(e) => e,
                    Err(_) => continue, // foreign/malformed: skip
                };
                let room = DiscoveredRoom {
                    room: entry.0,
                    addr: peer.ip().to_string(),
                    port: entry.1,
                    version: PROTOCOL_VERSION.to_string(),
                };
                let dupe = found.iter().any(|d| {
                    d.addr == room.addr
                        && d.port == room.port
                        && d.room == room.room
                });
                if !dupe {
                    found.push(room);
                }
            }
            Err(e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue; // empty slice: keep collecting until deadline
            }
            Err(_) => continue, // transient socket hiccup: keep collecting
        }
    }
    Ok(found)
}

/// Serialize a beacon to its JSON wire form.
pub fn encode_announcement(room: &str, tcp_port: u16) -> String {
    format!(
        "{{\"version\":\"{}\",\"service\":\"{}\",\"room\":\"{}\",\"port\":{}}}",
        escape_json_string(PROTOCOL_VERSION),
        escape_json_string(MDNS_SERVICE),
        escape_json_string(room),
        tcp_port
    )
}

/// Parse and gate a beacon: version must match [`PROTOCOL_VERSION`],
/// `service` must equal [`MDNS_SERVICE`], `room` must be non-empty and
/// `port` must be non-zero. Returns (`room`, `port`) on success.
pub fn decode_announcement(json: &str) -> Result<(String, u16), String> {
    let fields = BeaconParser::new(json).parse_top_object()?;
    let version = str_field(&fields, "version")?;
    handshake(&version, PROTOCOL_VERSION)?;
    let service = str_field(&fields, "service")?;
    if service != MDNS_SERVICE {
        return Err(format!("unknown service: {service}"));
    }
    let room = str_field(&fields, "room")?;
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    let port_text = num_field(&fields, "port")?;
    let port: u16 = port_text
        .parse()
        .map_err(|_| "malformed beacon json: bad port".to_string())?;
    if port == 0 {
        return Err("invalid port: 0 (use 1-65535)".to_string());
    }
    Ok((room, port))
}

fn escape_json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

/// Minimal JSON value tree: strings/numbers survive; every other value
/// folds to `Other` (unknown fields are ignored).
enum JsonValue {
    Str(String),
    Num(String),
    Other,
}

/// Minimal structural JSON parser for beacon objects, std-only.
/// Parses exactly one top-level `{...}`; duplicate keys resolve
/// last-wins at lookup time (parity with [`super::tcp`]).
struct BeaconParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> BeaconParser<'a> {
    fn new(json: &'a str) -> BeaconParser<'a> {
        BeaconParser {
            bytes: json.as_bytes(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, byte: u8, what: &str) -> Result<(), String> {
        if self.peek() == Some(byte) {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!("malformed beacon json: expected {what}"))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"', "`\"`")?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let byte = self.peek().ok_or_else(|| {
                "malformed beacon json: unterminated string".to_string()
            })?;
            self.pos += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let esc = self.peek().ok_or_else(|| {
                        "malformed beacon json: unterminated escape".to_string()
                    })?;
                    self.pos += 1;
                    match esc {
                        b'"' => buf.push(b'"'),
                        b'\\' => buf.push(b'\\'),
                        b'/' => buf.push(b'/'),
                        b'b' => buf.push(0x08),
                        b'f' => buf.push(0x0C),
                        b'n' => buf.push(b'\n'),
                        b'r' => buf.push(b'\r'),
                        b't' => buf.push(b'\t'),
                        b'u' => {
                            let code = self.parse_hex4()?;
                            let ch = if (0xD800..0xDC00).contains(&code) {
                                let low = self.parse_unicode_escape()?;
                                if !(0xDC00..0xE000).contains(&low) {
                                    return Err(
                                        "malformed beacon json: lone surrogate"
                                            .to_string(),
                                    );
                                }
                                let full = 0x10000
                                    + ((code - 0xD800) << 10)
                                    + (low - 0xDC00);
                                char::from_u32(full).ok_or_else(|| {
                                    "malformed beacon json: bad \\u escape"
                                        .to_string()
                                })?
                            } else if (0xDC00..0xE000).contains(&code) {
                                return Err(
                                    "malformed beacon json: lone surrogate"
                                        .to_string(),
                                );
                            } else {
                                char::from_u32(code).ok_or_else(|| {
                                    "malformed beacon json: bad \\u escape"
                                        .to_string()
                                })?
                            };
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(
                                ch.encode_utf8(&mut tmp).as_bytes(),
                            );
                        }
                        _ => {
                            return Err(
                                "malformed beacon json: invalid escape"
                                    .to_string(),
                            );
                        }
                    }
                }
                0x00..=0x1F => {
                    return Err(
                        "malformed beacon json: unescaped control char"
                            .to_string(),
                    );
                }
                _ => buf.push(byte),
            }
        }
        String::from_utf8(buf)
            .map_err(|_| "malformed beacon json: invalid utf-8".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.bytes.len() {
            return Err(
                "malformed beacon json: truncated \\u escape".to_string()
            );
        }
        let digits = &self.bytes[self.pos..self.pos + 4];
        let text = std::str::from_utf8(digits)
            .map_err(|_| "malformed beacon json: bad \\u escape".to_string())?;
        let code = u32::from_str_radix(text, 16)
            .map_err(|_| "malformed beacon json: bad \\u escape".to_string())?;
        self.pos += 4;
        Ok(code)
    }

    fn parse_unicode_escape(&mut self) -> Result<u32, String> {
        if self.peek() == Some(b'\\')
            && self.bytes.get(self.pos + 1) == Some(&b'u')
        {
            self.pos += 2;
            self.parse_hex4()
        } else {
            Err("malformed beacon json: lone surrogate".to_string())
        }
    }

    fn parse_number(&mut self) -> Result<String, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let mut digits = 0;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == b'.' || c == b'+' || c == b'-'
            {
                self.pos += 1;
                digits += 1;
            } else {
                break;
            }
        }
        if digits == 0 {
            return Err("malformed beacon json: bad value".to_string());
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .map(|s| s.to_string())
            .map_err(|_| "malformed beacon json: bad number".to_string())
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'"') => Ok(JsonValue::Str(self.parse_string()?)),
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                Ok(JsonValue::Num(self.parse_number()?))
            }
            Some(c)
                if c.is_ascii_alphabetic()
                    || c == b'+'
                    || c == b'.' =>
            {
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric()
                        || c == b'-'
                        || c == b'+'
                        || c == b'.'
                    {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
                Ok(JsonValue::Other)
            }
            _ => Err("malformed beacon json: bad value".to_string()),
        }
    }

    fn parse_top_object(
        mut self,
    ) -> Result<Vec<(String, JsonValue)>, String> {
        self.skip_ws();
        self.expect(b'{', "`{`")?;
        let mut fields = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
        } else {
            loop {
                self.skip_ws();
                if self.peek() != Some(b'"') {
                    return Err(
                        "malformed beacon json: expected string key".to_string()
                    );
                }
                let key = self.parse_string()?;
                self.skip_ws();
                self.expect(b':', "`:`")?;
                let value = self.parse_value()?;
                fields.push((key, value));
                self.skip_ws();
                match self.peek() {
                    Some(b',') => {
                        self.pos += 1;
                    }
                    Some(b'}') => {
                        self.pos += 1;
                        break;
                    }
                    _ => {
                        return Err(
                            "malformed beacon json: expected `,` or `}`"
                                .to_string(),
                        );
                    }
                }
            }
        }
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err("malformed beacon json: trailing characters".to_string());
        }
        Ok(fields)
    }
}

fn str_field(
    fields: &[(String, JsonValue)],
    key: &str,
) -> Result<String, String> {
    fields
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| match v {
            JsonValue::Str(s) => Some(s.clone()),
            _ => None,
        })
        .ok_or_else(|| format!("missing field: {key}"))
}

fn num_field(
    fields: &[(String, JsonValue)],
    key: &str,
) -> Result<String, String> {
    fields
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| match v {
            JsonValue::Num(s) => Some(s.clone()),
            _ => None,
        })
        .ok_or_else(|| format!("missing field: {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beacon_roundtrip_preserves_room_and_port() {
        let wire = encode_announcement("room-7000", 7000);
        assert!(wire.contains(MDNS_SERVICE), "got: {wire}");
        assert!(wire.contains(PROTOCOL_VERSION), "got: {wire}");
        assert_eq!(decode_announcement(&wire).unwrap(), ("room-7000".into(), 7000));
    }

    #[test]
    fn beacon_roundtrip_escapes_room_names() {
        let wire = encode_announcement("weird \"room\" \\ é", 7000);
        let (room, port) = decode_announcement(&wire).unwrap();
        assert_eq!(room, "weird \"room\" \\ é");
        assert_eq!(port, 7000);
    }

    #[test]
    fn beacon_rejects_foreign_version_service_and_bad_shape() {
        let stale = format!(
            "{{\"version\":\"0.9\",\"service\":\"{MDNS_SERVICE}\",\"room\":\"r\",\"port\":7000}}"
        );
        let err = decode_announcement(&stale).unwrap_err();
        assert!(err.contains("version mismatch"), "got: {err}");
        let foreign = format!(
            "{{\"version\":\"{PROTOCOL_VERSION}\",\"service\":\"_other._tcp\",\"room\":\"r\",\"port\":7000}}"
        );
        let err = decode_announcement(&foreign).unwrap_err();
        assert!(err.contains("unknown service"), "got: {err}");
        for (bad, want) in [
            ("not json", "malformed"),
            ("", "malformed"),
            (
                "{\"version\":\"1.0\",\"service\":\"_vtt._tcp\",\"room\":\"r\"}",
                "missing field: port",
            ),
            (
                "{\"version\":\"1.0\",\"service\":\"_vtt._tcp\",\"room\":\"\",\"port\":7000}",
                "missing field: room",
            ),
            (
                "{\"version\":\"1.0\",\"service\":\"_vtt._tcp\",\"room\":\"r\",\"port\":0}",
                "invalid port",
            ),
            (
                "{\"version\":\"1.0\",\"service\":\"_vtt._tcp\",\"room\":\"r\",\"port\":\"7000\"}",
                "missing field: port",
            ),
            (
                "{\"version\":\"1.0\",\"service\":\"_vtt._tcp\",\"room\":\"r\",\"port\":7000}trailing",
                "trailing",
            ),
        ] {
            let err = decode_announcement(bad).unwrap_err();
            assert!(err.contains(want), "input {bad:?} gave: {err}");
        }
    }

    #[test]
    fn announce_validates_without_touching_the_network() {
        assert!(announce("", 7000).is_err());
        assert!(announce("r", 0).is_err());
    }
}
