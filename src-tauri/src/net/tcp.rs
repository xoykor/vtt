//! Real TCP transport for the P2P handshake, snapshot and deltas.
//!
//! Wire framing is length-prefixed: `u32` big-endian length + payload
//! bytes, capped at [`MAX_FRAME_BYTES`]. Payloads are JSON:
//!
//! * handshake: `{"version":"1.0","room":"...","role":"guest"}` via
//!   [`super::encode_handshake`] / [`super::decode_handshake`];
//! * room reply: `{"version":"1.0","room":"...","port":7000}` via
//!   [`encode_room_info`] / [`decode_room_info`];
//! * snapshot: [`crate::save::export_json`] / [`crate::save::import_json`];
//! * delta: `{"upsert":{"k":"v"},"remove":["r"]}` via
//!   [`encode_delta`] / [`decode_delta`].
//!
//! Flow: the guest dials and sends one handshake frame; the host reads it,
//! version-gates it ([`super::decode_handshake`] rejects stale versions),
//! replies with one room frame and returns the [`super::Handshake`]. The
//! guest validates the room reply and returns the [`super::RoomInfo`].
//! Critical state (snapshot + deltas) travels here over ordered TCP;
//! ephemeral cursor/light updates travel over UDP ([`super::Channel`]).
//! The host is authoritative. mDNS (`_vtt._tcp`) stays out of this module.
//!
//! Failure policy: every fallible step maps errors to `String` — no
//! `.expect`/`.unwrap`/panics on any network or parse path, so callers get
//! fail-closed `Err` (e.g. version mismatch) instead of a crash. Tests bind
//! `127.0.0.1:0` (ephemeral port), never fixed ports.
//!
//! Rejection policy (no typed error frame): when the host rejects a
//! handshake (stale version, malformed JSON) it returns `Err` and closes
//! the connection without replying. The guest then observes EOF on its
//! pending read (`tcp read failed: ...`) — EOF-after-handshake IS the
//! rejection signal. Both sides surface `Err`, never a hang: accept,
//! connect and handshake reads are all capped by [`HANDSHAKE_TIMEOUT`].

use super::{Delta, Handshake, Role, RoomInfo, PROTOCOL_VERSION};
use super::{decode_handshake, encode_handshake, handshake};
use super::super::save::{GameSave, export_json, import_json};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

/// Largest accepted frame payload (1 MiB). Snapshots of token state are
/// KiB-scale and map assets travel out-of-band by hash (`assets.rs`), so
/// anything larger is rejected fail-closed instead of buffering.
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Fail-closed cap for accept/connect/handshake reads: a peer that dials
/// and never speaks (or never answers) cannot park the server loop forever.
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// Accept exactly one connection, read one handshake frame, version-gate
/// it, reply with the room frame and return the accepted handshake.
///
/// The room reply echoes the guest's room bound to this listener's actual
/// port. Stale versions, malformed JSON and oversized frames yield `Err`
/// and the connection closes with NO error frame — the guest's pending
/// read fails with EOF (`tcp read failed`), which is the rejection signal.
/// Accept and the handshake read are capped by [`HANDSHAKE_TIMEOUT`] so a
/// silent peer cannot block the server loop (cancel via dropping the
/// returned future / shutdown handle in later tasks).
pub async fn serve_once(listener: TcpListener) -> Result<Handshake, String> {
    let (mut stream, _peer) = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        listener.accept(),
    )
    .await
    .map_err(|_| "tcp accept timed out after 10s".to_string())?
    .map_err(|e| format!("tcp accept failed: {e}"))?;
    let frame = tokio::time::timeout(HANDSHAKE_TIMEOUT, recv_frame(&mut stream))
        .await
        .map_err(|_| "tcp handshake timed out after 10s".to_string())??;
    let text = std::str::from_utf8(&frame)
        .map_err(|_| "malformed handshake json: invalid utf-8".to_string())?;
    let hs = decode_handshake(text)?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("tcp local_addr failed: {e}"))?
        .port();
    let info = RoomInfo {
        room: hs.room.clone(),
        port,
        version: PROTOCOL_VERSION.to_string(),
    };
    send_frame(&mut stream, encode_room_info(&info).as_bytes()).await?;
    Ok(hs)
}

/// Dial `addr`, handshake as guest for `room-<port>` and return the host's
/// room reply. Thin default over [`connect_with_handshake`].
pub async fn connect_handshake(addr: SocketAddr) -> Result<RoomInfo, String> {
    let guest = Handshake {
        version: PROTOCOL_VERSION.to_string(),
        room: format!("room-{}", addr.port()),
        role: Role::Guest,
    };
    connect_with_handshake(addr, &guest).await
}

/// Dial `addr`, send `guest` as the handshake frame and return the host's
/// validated room reply. Version mismatches (either side) yield `Err`: a
/// rejecting host closes without a reply frame, so this surfaces as an
/// EOF read failure — EOF-after-handshake is the rejection. Connect and
/// the reply read are capped by [`HANDSHAKE_TIMEOUT`].
pub async fn connect_with_handshake(
    addr: SocketAddr,
    guest: &Handshake,
) -> Result<RoomInfo, String> {
    let mut stream = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        TcpStream::connect(addr),
    )
    .await
    .map_err(|_| format!("tcp connect timed out after 10s [{addr}]"))?
    .map_err(|e| format!("tcp connect failed [{addr}]: {e}"))?;
    send_frame(&mut stream, encode_handshake(guest).as_bytes()).await?;
    let frame = tokio::time::timeout(HANDSHAKE_TIMEOUT, recv_frame(&mut stream))
        .await
        .map_err(|_| format!("tcp handshake timed out after 10s [{addr}]"))??;
    let text = std::str::from_utf8(&frame)
        .map_err(|_| "malformed room json: invalid utf-8".to_string())?;
    decode_room_info(text)
}

/// Write one length-prefixed frame (`u32` BE length + payload).
pub async fn send_frame(
    stream: &mut TcpStream,
    payload: &[u8],
) -> Result<(), String> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(format!(
            "frame too large: {} bytes (max {MAX_FRAME_BYTES})",
            payload.len()
        ));
    }
    let len = (payload.len() as u32).to_be_bytes();
    stream
        .write_all(&len)
        .await
        .map_err(|e| format!("tcp write failed: {e}"))?;
    stream
        .write_all(payload)
        .await
        .map_err(|e| format!("tcp write failed: {e}"))?;
    Ok(())
}

/// Read one length-prefixed frame, fail-closed past [`MAX_FRAME_BYTES`].
pub async fn recv_frame(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut len_buf = [0u8; 4];
    stream
        .read_exact(&mut len_buf)
        .await
        .map_err(|e| format!("tcp read failed: {e}"))?;
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(format!(
            "frame too large: {len} bytes (max {MAX_FRAME_BYTES})"
        ));
    }
    let mut buf = vec![0u8; len];
    stream
        .read_exact(&mut buf)
        .await
        .map_err(|e| format!("tcp read failed: {e}"))?;
    Ok(buf)
}

/// Send a full state snapshot as one frame (host → guest on (re)join).
pub async fn send_snapshot(
    stream: &mut TcpStream,
    save: &GameSave,
) -> Result<(), String> {
    send_frame(stream, export_json(save).as_bytes()).await
}

/// Receive one snapshot frame; version-checked via [`import_json`].
pub async fn recv_snapshot(stream: &mut TcpStream) -> Result<GameSave, String> {
    let frame = recv_frame(stream).await?;
    let text = std::str::from_utf8(&frame)
        .map_err(|_| "malformed save json: invalid utf-8".to_string())?;
    import_json(text)
}

/// Send one state delta as a frame ([`encode_delta`]).
pub async fn send_delta(
    stream: &mut TcpStream,
    delta: &Delta,
) -> Result<(), String> {
    send_frame(stream, encode_delta(delta).as_bytes()).await
}

/// Receive one delta frame ([`decode_delta`]).
pub async fn recv_delta(stream: &mut TcpStream) -> Result<Delta, String> {
    let frame = recv_frame(stream).await?;
    let text = std::str::from_utf8(&frame)
        .map_err(|_| "malformed delta json: invalid utf-8".to_string())?;
    decode_delta(text)
}

/// Serialize a room reply to its JSON wire form.
pub fn encode_room_info(info: &RoomInfo) -> String {
    format!(
        "{{\"version\":\"{}\",\"room\":\"{}\",\"port\":{}}}",
        escape_json_string(&info.version),
        escape_json_string(&info.room),
        info.port
    )
}

/// Parse and version-check a room reply from its JSON wire form.
pub fn decode_room_info(json: &str) -> Result<RoomInfo, String> {
    let fields = JsonParser::new(json).parse_top_object()?;
    let version = str_field(&fields, "version")?;
    handshake(&version, PROTOCOL_VERSION)?;
    let room = str_field(&fields, "room")?;
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    let port_text = num_field(&fields, "port")?;
    let port: u16 = port_text
        .parse()
        .map_err(|_| "malformed room json: bad port".to_string())?;
    if port == 0 {
        return Err("invalid port: 0 (use 1-65535)".to_string());
    }
    Ok(RoomInfo {
        room,
        port,
        version,
    })
}

/// Serialize a delta to its JSON wire form.
pub fn encode_delta(delta: &Delta) -> String {
    let mut out = String::from("{\"upsert\":{");
    for (i, (key, value)) in delta.upsert.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&escape_json_string(key));
        out.push_str("\":\"");
        out.push_str(&escape_json_string(value));
        out.push('"');
    }
    out.push_str("},\"remove\":[");
    for (i, key) in delta.remove.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(&escape_json_string(key));
        out.push('"');
    }
    out.push_str("]}");
    out
}

/// Parse a delta from its JSON wire form.
pub fn decode_delta(json: &str) -> Result<Delta, String> {
    let fields = JsonParser::new(json).parse_top_object()?;
    let upsert_value = fields
        .iter()
        .rev()
        .find(|(key, _)| key == "upsert")
        .map(|(_, value)| value)
        .ok_or_else(|| "missing field: upsert".to_string())?;
    let upsert = match upsert_value {
        JsonValue::Obj(pairs) => {
            let mut out = Vec::with_capacity(pairs.len());
            for (key, value) in pairs {
                match value {
                    JsonValue::Str(s) => out.push((key.clone(), s.clone())),
                    _ => {
                        return Err(
                            "malformed delta json: upsert values must be strings"
                                .to_string(),
                        );
                    }
                }
            }
            out
        }
        _ => {
            return Err(
                "malformed delta json: upsert must be an object".to_string()
            );
        }
    };
    let remove_value = fields
        .iter()
        .rev()
        .find(|(key, _)| key == "remove")
        .map(|(_, value)| value)
        .ok_or_else(|| "missing field: remove".to_string())?;
    let remove = match remove_value {
        JsonValue::Arr(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item {
                    JsonValue::Str(s) => out.push(s.clone()),
                    _ => {
                        return Err(
                            "malformed delta json: remove items must be strings"
                                .to_string(),
                        );
                    }
                }
            }
            out
        }
        _ => {
            return Err(
                "malformed delta json: remove must be an array".to_string()
            );
        }
    };
    Ok(Delta { upsert, remove })
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

/// Minimal JSON value tree: strings/numbers/objects/arrays survive, every
/// other literal folds to `Other` (unknown fields are ignored downstream).
enum JsonValue {
    Str(String),
    Num(String),
    Obj(Vec<(String, JsonValue)>),
    Arr(Vec<JsonValue>),
    Other,
}

/// Minimal structural JSON parser for room/delta objects, std-only.
/// Parses exactly one top-level `{...}`; unknown fields hold any JSON value
/// and are ignored. Duplicate keys resolve last-wins at lookup time.
struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(json: &'a str) -> JsonParser<'a> {
        JsonParser {
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
            Err(format!("malformed room json: expected {what}"))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"', "`\"`")?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| {
                    "malformed room json: unterminated string".to_string()
                })?;
            self.pos += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let esc = self.peek().ok_or_else(|| {
                        "malformed room json: unterminated escape".to_string()
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
                                        "malformed room json: lone surrogate"
                                            .to_string(),
                                    );
                                }
                                let full = 0x10000
                                    + ((code - 0xD800) << 10)
                                    + (low - 0xDC00);
                                char::from_u32(full).ok_or_else(|| {
                                    "malformed room json: bad \\u escape"
                                        .to_string()
                                })?
                            } else if (0xDC00..0xE000).contains(&code) {
                                return Err(
                                    "malformed room json: lone surrogate"
                                        .to_string(),
                                );
                            } else {
                                char::from_u32(code).ok_or_else(|| {
                                    "malformed room json: bad \\u escape"
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
                                "malformed room json: invalid escape".to_string()
                            );
                        }
                    }
                }
                0x00..=0x1F => {
                    return Err(
                        "malformed room json: unescaped control char".to_string()
                    );
                }
                _ => buf.push(byte),
            }
        }
        String::from_utf8(buf)
            .map_err(|_| "malformed room json: invalid utf-8".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.bytes.len() {
            return Err(
                "malformed room json: truncated \\u escape".to_string()
            );
        }
        let digits = &self.bytes[self.pos..self.pos + 4];
        let text = std::str::from_utf8(digits)
            .map_err(|_| "malformed room json: bad \\u escape".to_string())?;
        let code = u32::from_str_radix(text, 16)
            .map_err(|_| "malformed room json: bad \\u escape".to_string())?;
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
            Err("malformed room json: lone surrogate".to_string())
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
            return Err("malformed room json: bad value".to_string());
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .map(|s| s.to_string())
            .map_err(|_| "malformed room json: bad number".to_string())
    }

    fn parse_value(&mut self) -> Result<JsonValue, String> {
        self.skip_ws();
        match self.peek() {
            Some(b'"') => Ok(JsonValue::Str(self.parse_string()?)),
            Some(b'{') => {
                self.pos += 1;
                let mut pairs = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b'}') {
                    self.pos += 1;
                    return Ok(JsonValue::Obj(pairs));
                }
                loop {
                    self.skip_ws();
                    if self.peek() != Some(b'"') {
                        return Err(
                            "malformed room json: expected string key".to_string()
                        );
                    }
                    let key = self.parse_string()?;
                    self.skip_ws();
                    self.expect(b':', "`:`")?;
                    let value = self.parse_value()?;
                    pairs.push((key, value));
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b'}') => {
                            self.pos += 1;
                            return Ok(JsonValue::Obj(pairs));
                        }
                        _ => {
                            return Err(
                                "malformed room json: expected `,` or `}`"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
            Some(b'[') => {
                self.pos += 1;
                let mut items = Vec::new();
                self.skip_ws();
                if self.peek() == Some(b']') {
                    self.pos += 1;
                    return Ok(JsonValue::Arr(items));
                }
                loop {
                    let value = self.parse_value()?;
                    items.push(value);
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => {
                            self.pos += 1;
                        }
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(JsonValue::Arr(items));
                        }
                        _ => {
                            return Err(
                                "malformed room json: expected `,` or `]`"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
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
            _ => Err("malformed room json: bad value".to_string()),
        }
    }

    fn parse_top_object(mut self) -> Result<Vec<(String, JsonValue)>, String> {
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
                        "malformed room json: expected string key".to_string()
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
                            "malformed room json: expected `,` or `}`"
                                .to_string(),
                        );
                    }
                }
            }
        }
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err("malformed room json: trailing characters".to_string());
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
    fn room_info_roundtrip_preserves_fields() {
        let info = RoomInfo {
            room: "room-7000".to_string(),
            port: 7000,
            version: PROTOCOL_VERSION.to_string(),
        };
        let back = decode_room_info(&encode_room_info(&info)).expect("valid");
        assert_eq!(back, info);
    }

    #[test]
    fn room_info_rejects_stale_version_and_bad_shape() {
        let stale = r#"{"version":"0.9","room":"r","port":7000}"#;
        let err = decode_room_info(stale).expect_err("stale must fail");
        assert!(err.contains("version mismatch"), "got: {err}");
        for (bad, want) in [
            ("not json", "malformed"),
            ("", "malformed"),
            (
                r#"{"version":"1.0","room":"r"}"#,
                "missing field: port",
            ),
            (
                r#"{"version":"1.0","room":"","port":7000}"#,
                "missing field: room",
            ),
            (
                r#"{"version":"1.0","room":"r","port":0}"#,
                "invalid port",
            ),
            (
                r#"{"version":"1.0","room":"r","port":"7000"}"#,
                "missing field: port",
            ),
            (
                "{\"version\":\"1.0\",\"room\":\"r\",\"port\":7000}trailing",
                "trailing",
            ),
        ] {
            let err = decode_room_info(bad).expect_err("must fail");
            assert!(err.contains(want), "input {bad:?} gave: {err}");
        }
    }

    #[test]
    fn delta_roundtrip_escapes_everything() {
        let delta = Delta {
            upsert: vec![
                ("weird \"key\" \\ é".to_string(), "line1\nline2\tünï".to_string()),
                ("p1".to_string(), "v1".to_string()),
            ],
            remove: vec!["a \"b\"".to_string()],
        };
        let wire = encode_delta(&delta);
        assert!(wire.contains("\\\"key\\\""));
        let back = decode_delta(&wire).expect("valid");
        assert_eq!(back, delta);
    }

    #[test]
    fn delta_rejects_malformed_and_wrong_types() {
        for (bad, want) in [
            ("not json".to_string(), "malformed"),
            ("".to_string(), "malformed"),
            (
                r#"{"upsert":{},"remove":[]}trailing"#.to_string(),
                "trailing",
            ),
            (
                r#"{"upsert":{}}"#.to_string(),
                "missing field: remove",
            ),
            (
                r#"{"remove":[]}"#.to_string(),
                "missing field: upsert",
            ),
            (
                r#"{"upsert":[],"remove":[]}"#.to_string(),
                "must be an object",
            ),
            (
                r#"{"upsert":{},"remove":{}}"#.to_string(),
                "must be an array",
            ),
            (
                r#"{"upsert":{"k":5},"remove":[]}"#.to_string(),
                "must be strings",
            ),
            (
                r#"{"upsert":{},"remove":[5]}"#.to_string(),
                "must be strings",
            ),
        ] {
            let err = decode_delta(&bad).expect_err("must fail");
            assert!(err.contains(want), "input {bad:?} gave: {err}");
        }
    }
}
