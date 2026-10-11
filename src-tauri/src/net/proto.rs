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
///
/// Minimal `serde_json` stand-in: string values are escaped (`"` and `\`
/// at minimum, plus control chars) so user-controlled `room` names always
/// round-trip. Delete in favor of `serde_json` when `tauri` lands.
pub fn encode_handshake(h: &Handshake) -> String {
    format!(
        "{{\"version\":\"{}\",\"room\":\"{}\",\"role\":\"{}\"}}",
        escape_json_string(&h.version),
        escape_json_string(&h.room),
        h.role.as_str()
    )
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

/// Minimal structural JSON parser for handshake objects, std-only.
///
/// Parses exactly one top-level `{...}` object with string keys; known
/// fields must hold strings, unknown fields hold any JSON value and are
/// ignored. Duplicate keys resolve last-wins (serde_json parity).
/// Anything else — non-objects, malformed structure, trailing garbage —
/// is an error. Replace with `serde_json` when `tauri` lands.
struct ObjectParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> ObjectParser<'a> {
    fn new(json: &'a str) -> ObjectParser<'a> {
        ObjectParser {
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
            Err(format!("malformed handshake json: expected {what}"))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"', "`\"`")?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let byte = self.peek().ok_or_else(|| {
                "malformed handshake json: unterminated string".to_string()
            })?;
            self.pos += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let esc = self.peek().ok_or_else(|| {
                        "malformed handshake json: unterminated escape"
                            .to_string()
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
                                    return Err("malformed handshake json: lone surrogate"
                                        .to_string());
                                }
                                let full = 0x10000
                                    + ((code - 0xD800) << 10)
                                    + (low - 0xDC00);
                                char::from_u32(full).ok_or_else(|| {
                                    "malformed handshake json: bad \\u escape"
                                        .to_string()
                                })?
                            } else {
                                char::from_u32(code).ok_or_else(|| {
                                    "malformed handshake json: bad \\u escape"
                                        .to_string()
                                })?
                            };
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        _ => {
                            return Err(
                                "malformed handshake json: invalid escape".to_string()
                            );
                        }
                    }
                }
                0x00..=0x1F => {
                    return Err(
                        "malformed handshake json: unescaped control char".to_string()
                    );
                }
                _ => buf.push(byte),
            }
        }
        String::from_utf8(buf).map_err(|_| {
            "malformed handshake json: invalid utf-8".to_string()
        })
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.bytes.len() {
            return Err(
                "malformed handshake json: truncated \\u escape".to_string()
            );
        }
        let digits = &self.bytes[self.pos..self.pos + 4];
        let text = std::str::from_utf8(digits).map_err(|_| {
            "malformed handshake json: bad \\u escape".to_string()
        })?;
        let code = u32::from_str_radix(text, 16).map_err(|_| {
            "malformed handshake json: bad \\u escape".to_string()
        })?;
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
            Err("malformed handshake json: lone surrogate".to_string())
        }
    }

    /// Skip one arbitrary JSON value (unknown fields accept anything).
    fn skip_value(&mut self) -> Result<(), String> {
        self.skip_ws();
        match self.peek() {
            Some(b'"') => {
                self.parse_string()?;
                Ok(())
            }
            Some(b'{') => {
                self.pos += 1;
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(());
                }
                loop {
                    self.skip_ws();
                    if self.peek() != Some(b'"') {
                        return Err(
                            "malformed handshake json: expected string key".to_string()
                        );
                    }
                    self.parse_string()?;
                    self.skip_ws();
                    self.expect(b':', "`:`")?;
                    self.skip_value()?;
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b'}') => {
                            self.pos += 1;
                            return Ok(());
                        }
                        _ => {
                            return Err(
                                "malformed handshake json: expected `,` or `}`"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
            Some(b'[') => {
                self.pos += 1;
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(());
                }
                loop {
                    self.skip_value()?;
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(());
                        }
                        _ => {
                            return Err(
                                "malformed handshake json: expected `,` or `]`"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
            Some(c) if c.is_ascii_alphanumeric() || c == b'-' || c == b'.' || c == b'+' => {
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
                Ok(())
            }
            _ => Err("malformed handshake json: bad value".to_string()),
        }
    }

    fn parse_object(mut self) -> Result<Vec<(String, Option<String>)>, String> {
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
                        "malformed handshake json: expected string key".to_string()
                    );
                }
                let key = self.parse_string()?;
                self.skip_ws();
                self.expect(b':', "`:`")?;
                self.skip_ws();
                let value = if self.peek() == Some(b'"') {
                    Some(self.parse_string()?)
                } else {
                    self.skip_value()?;
                    None
                };
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
                            "malformed handshake json: expected `,` or `}`".to_string()
                        );
                    }
                }
            }
        }
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err("malformed handshake json: trailing characters".to_string());
        }
        Ok(fields)
    }
}

fn lookup_field(fields: &[(String, Option<String>)], key: &str) -> Result<String, String> {
    fields
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| v.clone())
        .ok_or_else(|| format!("missing field: {key}"))
}

/// Parse and version-check a handshake from its JSON wire form.
pub fn decode_handshake(json: &str) -> Result<Handshake, String> {
    let fields = ObjectParser::new(json).parse_object()?;
    let version = lookup_field(&fields, "version")?;
    handshake(&version, PROTOCOL_VERSION)?;
    let room = lookup_field(&fields, "room")?;
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    let role = Role::parse(&lookup_field(&fields, "role")?)?;
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
    fn roundtrip_escapes_quotes_backslashes_and_controls() {
        let h = Handshake {
            version: PROTOCOL_VERSION.to_string(),
            room: "weird \"room\" \\ name\n\té".to_string(),
            role: Role::Guest,
        };
        let wire = encode_handshake(&h);
        // Structural check: the room value must not leak a raw quote.
        assert!(wire.contains("\\\"room\\\""));
        assert!(wire.contains("\\\\"));
        let back = decode_handshake(&wire).unwrap();
        assert_eq!(back, h);
    }

    #[test]
    fn decode_reads_key_substring_inside_value() {
        // Old substring search matched `"role"` inside the room value.
        let json = r#"{"version":"1.0","room":"has \"role\" inside","role":"guest"}"#;
        let h = decode_handshake(json).unwrap();
        assert_eq!(h.room, "has \"role\" inside");
        assert_eq!(h.role, Role::Guest);
    }

    #[test]
    fn decode_rejects_missing_field() {
        let json = r#"{"version":"1.0","room":"r"}"#;
        let err = decode_handshake(json).unwrap_err();
        assert!(err.contains("missing field: role"), "got: {err}");
    }

    #[test]
    fn decode_rejects_unknown_role() {
        let json = r#"{"version":"1.0","room":"r","role":"admin"}"#;
        let err = decode_handshake(json).unwrap_err();
        assert!(err.contains("unknown role"), "got: {err}");
    }

    #[test]
    fn decode_rejects_malformed_json() {
        for bad in [
            "not json",
            "",
            "[1,2]",
            "\"just a string\"",
            r#"{"version":"1.0","room":"r""#, // truncated
            "{\"version\":\"1.0\",\"room\":\"r\",\"role\":\"guest\"}trailing", // garbage
            r#"{"version":"1.0","room":"r","role":"guest",}"#, // trailing comma
            r#"{"version":1.0,"room":"r","role":"guest"}"#,   // non-string version
            r#"{"version":"1.0","room":"r","role":"guest""#,  // missing brace
            "{\"version\":\"1.0\",\"room\":\"bad \\q escape\",\"role\":\"guest\"}",
        ] {
            assert!(decode_handshake(bad).is_err(), "accepted: {bad}");
        }
    }

    #[test]
    fn decode_ignores_extra_fields_and_dupes_last_wins() {
        let json = r#"{"version":"1.0","room":"r","role":"host","n":5,"o":{"a":[1,2]},"s":"x"}"#;
        assert_eq!(decode_handshake(json).unwrap().role, Role::Host);
        let dupe = r#"{"version":"1.0","room":"r","role":"host","role":"guest"}"#;
        assert_eq!(decode_handshake(dupe).unwrap().role, Role::Guest);
    }

    #[test]
    fn channels_split_state_and_cursor() {
        assert_eq!(Channel::TcpState.transport(), "tcp");
        assert_eq!(Channel::UdpCursor.transport(), "udp");
    }
}
