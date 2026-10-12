//! Ephemeral cursor/light updates over UDP (best-effort).
//!
//! Policy (from [`super::Channel`]): cursor and light state is
//! loss-tolerant — it is re-sent every frame/pointermove, so a dropped
//! datagram is superseded by the next one. Consequences, by design:
//!
//! * **No delivery guarantee.** [`send_cursor`] reports only that the
//!   datagram left the local socket; absence on the peer is normal.
//! * **No handshake, no ordering, no retransmit inside this module.**
//!   The sender repeats; the receiver keeps the newest message per peer.
//! * **No authority check here.** The host is authoritative (critical
//!   state travels over TCP in [`super::tcp`]); guests render what the
//!   host relays. Enforce roles at the call site, not in the codec.
//!
//! Wire format is JSON, std-only (no `serde_json`, mirroring
//! [`super::proto`]): `{"room":"...","id":"...","x":1.5,"y":2.5}`.
//! `x`/`y` must be finite; non-finite values are rejected fail-closed on
//! decode. There is intentionally no `version` field: the peer already
//! proved its version over the TCP handshake before any cursor flows.
//!
//! Failure policy: every fallible step maps errors to `String` — no
//! `.expect`/`.unwrap`/panics on any network or parse path. Receives are
//! always deadline-capped ([`recv_cursor_timeout`]); bare [`recv_cursor`]
//! blocks until one datagram arrives and is meant for tasks that already
//! own a shutdown/timeout mechanism.

use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::UdpSocket;

/// Largest accepted cursor datagram (1 KiB). Cursor payloads are
/// tens of bytes; anything larger is rejected fail-closed instead of
/// buffering (mirrors [`super::tcp::MAX_FRAME_BYTES`] policy, scaled to
/// datagram size).
pub const MAX_CURSOR_BYTES: usize = 1024;

/// One cursor/light sample: peer `id`'s pointer at (`x`, `y`) in `room`.
#[derive(Debug, Clone, PartialEq)]
pub struct CursorMsg {
    pub room: String,
    pub id: String,
    pub x: f32,
    pub y: f32,
}

/// Serialize a cursor message to its JSON wire form.
///
/// Infallible like [`super::encode_handshake`]: validation (non-empty
/// `room`/`id`, finite `x`/`y`) lives in [`decode_cursor`], so a
/// malformed message always fails on receipt, never on send.
pub fn encode_cursor(m: &CursorMsg) -> String {
    format!(
        "{{\"room\":\"{}\",\"id\":\"{}\",\"x\":{},\"y\":{}}}",
        escape_json_string(&m.room),
        escape_json_string(&m.id),
        FloatRepr(m.x),
        FloatRepr(m.y),
    )
}

/// Helper: `f32` Display is round-trip safe in Rust (`0.1f32` prints as
/// `0.1` and parses back to identical bits), so plain `{}` suffices —
/// no `ryu`/`serde_json` needed. Non-finite values print as `NaN`/`inf`
/// and are rejected by [`decode_cursor`] (`non-finite` error).
struct FloatRepr(f32);

impl std::fmt::Display for FloatRepr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Parse and validate a cursor message from its JSON wire form.
///
/// Unknown fields hold any JSON value and are ignored; duplicate keys
/// resolve last-wins (parity with [`super::tcp`] codecs). Empty `room`
/// / `id`, missing fields, wrong types, non-finite coordinates,
/// malformed structure and trailing garbage are all `Err`.
pub fn decode_cursor(json: &str) -> Result<CursorMsg, String> {
    let fields = CursorParser::new(json).parse_top_object()?;
    let room = str_field(&fields, "room")?;
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    let id = str_field(&fields, "id")?;
    if id.is_empty() {
        return Err("missing field: id".to_string());
    }
    let x = num_field(&fields, "x")?;
    let y = num_field(&fields, "y")?;
    Ok(CursorMsg { room, id, x, y })
}

/// Send one cursor datagram to `addr`. Best-effort: `Ok` means the
/// datagram left the local socket, NOT that the peer received it.
pub async fn send_cursor(
    sock: &UdpSocket,
    addr: SocketAddr,
    msg: &CursorMsg,
) -> Result<(), String> {
    let bytes = encode_cursor(msg).into_bytes();
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err(format!(
            "cursor too large: {} bytes (max {MAX_CURSOR_BYTES})",
            bytes.len()
        ));
    }
    sock.send_to(&bytes, addr)
        .await
        .map_err(|e| format!("udp send failed [{addr}]: {e}"))?;
    Ok(())
}

/// Receive one cursor datagram (any sender), fail-closed past
/// [`MAX_CURSOR_BYTES`] and on malformed payloads. Blocks until a
/// datagram arrives — prefer [`recv_cursor_timeout`] unless the caller
/// already owns a shutdown/timeout mechanism.
pub async fn recv_cursor(sock: &UdpSocket) -> Result<CursorMsg, String> {
    let mut buf = vec![0u8; MAX_CURSOR_BYTES + 512];
    let (n, _peer) = sock
        .recv_from(&mut buf)
        .await
        .map_err(|e| format!("udp recv failed: {e}"))?;
    decode_datagram(&buf[..n])
}

/// Receive one cursor datagram, giving up with `Err` after `timeout`
/// instead of blocking forever. A timeout is an ordinary best-effort
/// outcome (packet loss), not a bug — the sender just sends again.
pub async fn recv_cursor_timeout(
    sock: &UdpSocket,
    timeout: Duration,
) -> Result<CursorMsg, String> {
    tokio::time::timeout(timeout, recv_cursor(sock))
        .await
        .map_err(|_| {
            format!("udp recv timed out after {}ms", timeout.as_millis())
        })?
}

fn decode_datagram(bytes: &[u8]) -> Result<CursorMsg, String> {
    if bytes.len() > MAX_CURSOR_BYTES {
        return Err(format!(
            "cursor too large: {} bytes (max {MAX_CURSOR_BYTES})",
            bytes.len()
        ));
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "malformed cursor json: invalid utf-8".to_string())?;
    decode_cursor(text)
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

/// Minimal JSON value tree for cursor objects: strings and numbers
/// are read; bare literals (`true`, `NaN`, `inf`, ...) are kept as
/// `Bare` so coordinates can report `bad number` / `non-finite`
/// precisely; nested objects/arrays fold to `Other` (unknown fields).
enum JsonValue {
    Str(String),
    Num(String),
    Bare(String),
    Other,
}

/// Minimal structural JSON parser for cursor objects, std-only.
/// Parses exactly one top-level `{...}`; duplicate keys resolve
/// last-wins at lookup time (parity with [`super::tcp`]).
struct CursorParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> CursorParser<'a> {
    fn new(json: &'a str) -> CursorParser<'a> {
        CursorParser {
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
            Err(format!("malformed cursor json: expected {what}"))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"', "`\"`")?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let byte = self.peek().ok_or_else(|| {
                "malformed cursor json: unterminated string".to_string()
            })?;
            self.pos += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let esc = self.peek().ok_or_else(|| {
                        "malformed cursor json: unterminated escape".to_string()
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
                                        "malformed cursor json: lone surrogate"
                                            .to_string(),
                                    );
                                }
                                let full = 0x10000
                                    + ((code - 0xD800) << 10)
                                    + (low - 0xDC00);
                                char::from_u32(full).ok_or_else(|| {
                                    "malformed cursor json: bad \\u escape"
                                        .to_string()
                                })?
                            } else if (0xDC00..0xE000).contains(&code) {
                                return Err(
                                    "malformed cursor json: lone surrogate"
                                        .to_string(),
                                );
                            } else {
                                char::from_u32(code).ok_or_else(|| {
                                    "malformed cursor json: bad \\u escape"
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
                                "malformed cursor json: invalid escape"
                                    .to_string(),
                            );
                        }
                    }
                }
                0x00..=0x1F => {
                    return Err(
                        "malformed cursor json: unescaped control char"
                            .to_string(),
                    );
                }
                _ => buf.push(byte),
            }
        }
        String::from_utf8(buf)
            .map_err(|_| "malformed cursor json: invalid utf-8".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.bytes.len() {
            return Err(
                "malformed cursor json: truncated \\u escape".to_string()
            );
        }
        let digits = &self.bytes[self.pos..self.pos + 4];
        let text = std::str::from_utf8(digits)
            .map_err(|_| "malformed cursor json: bad \\u escape".to_string())?;
        let code = u32::from_str_radix(text, 16)
            .map_err(|_| "malformed cursor json: bad \\u escape".to_string())?;
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
            Err("malformed cursor json: lone surrogate".to_string())
        }
    }

    fn parse_number(&mut self) -> Result<String, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        let mut digits = 0;
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() {
                self.pos += 1;
                digits += 1;
            } else {
                break;
            }
        }
        if digits == 0 {
            return Err("malformed cursor json: bad number".to_string());
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            let mut frac = 0;
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    self.pos += 1;
                    frac += 1;
                } else {
                    break;
                }
            }
            if frac == 0 {
                return Err("malformed cursor json: bad number".to_string());
            }
        }
        if matches!(self.peek(), Some(b'e') | Some(b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+') | Some(b'-')) {
                self.pos += 1;
            }
            let mut exp = 0;
            while let Some(c) = self.peek() {
                if c.is_ascii_digit() {
                    self.pos += 1;
                    exp += 1;
                } else {
                    break;
                }
            }
            if exp == 0 {
                return Err("malformed cursor json: bad number".to_string());
            }
        }
        std::str::from_utf8(&self.bytes[start..self.pos])
            .map(|s| s.to_string())
            .map_err(|_| "malformed cursor json: bad number".to_string())
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
                            "malformed cursor json: expected string key"
                                .to_string(),
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
                                "malformed cursor json: expected `,` or `}`"
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
                                "malformed cursor json: expected `,` or `]`"
                                    .to_string(),
                            );
                        }
                    }
                }
            }
            Some(c) if c == b'-' || c.is_ascii_digit() => {
                self.parse_number()?;
                Ok(())
            }
            Some(c)
                if c.is_ascii_alphabetic()
                    || c == b'+'
                    || c == b'.' =>
            {
                // Bare literals (`true`, `null`, and the non-standard
                // `NaN`/`inf` our own encoder can emit for non-finite
                // floats): consume so unknown fields stay skippable, but
                // they NEVER validate as coordinates (see `num_field`).
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
            _ => Err("malformed cursor json: bad value".to_string()),
        }
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
                // Bare literal (`true`, `null`, or the non-standard
                // `NaN`/`inf` our own encoder emits for non-finite
                // floats): keep the text so coordinate fields can
                // distinguish `bad number` from `non-finite`; unknown
                // fields ignore it either way.
                let start = self.pos;
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
                std::str::from_utf8(&self.bytes[start..self.pos])
                    .map(|s| JsonValue::Bare(s.to_string()))
                    .map_err(|_| {
                        "malformed cursor json: bad value".to_string()
                    })
            }
            _ => {
                self.skip_value()?;
                Ok(JsonValue::Other)
            }
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
                        "malformed cursor json: expected string key".to_string()
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
                            "malformed cursor json: expected `,` or `}`"
                                .to_string(),
                        );
                    }
                }
            }
        }
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err("malformed cursor json: trailing characters".to_string());
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
        .ok_or_else(|| {
            format!("malformed cursor json: missing field: {key}")
        })
}

fn num_field(fields: &[(String, JsonValue)], key: &str) -> Result<f32, String> {
    let text = fields
        .iter()
        .rev()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| match v {
            JsonValue::Num(s) | JsonValue::Bare(s) => Some(s.clone()),
            _ => None,
        })
        .ok_or_else(|| {
            format!("malformed cursor json: missing field: {key}")
        })?;
    let value: f32 = text
        .parse()
        .map_err(|_| "malformed cursor json: bad number".to_string())?;
    if !value.is_finite() {
        return Err(format!(
            "malformed cursor json: non-finite coordinate for {key}"
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_preserves_all_fields() {
        let m = CursorMsg {
            room: "room-7000".to_string(),
            id: "dm".to_string(),
            x: 1.5,
            y: -2.25,
        };
        assert_eq!(decode_cursor(&encode_cursor(&m)).unwrap(), m);
    }

    #[test]
    fn decode_rejects_empty_room_or_id() {
        for bad in [
            r#"{"room":"","id":"p","x":1,"y":2}"#,
            r#"{"room":"r","id":"","x":1,"y":2}"#,
        ] {
            assert!(decode_cursor(bad).is_err(), "accepted: {bad}");
        }
    }

    #[test]
    fn decode_rejects_non_finite_coordinates() {
        // `parse::<f32>` accepts `NaN`/`inf`, so finiteness is checked
        // explicitly: an encoder fed a non-finite float emits JSON that
        // fail-closed decode refuses.
        let nan = CursorMsg {
            room: "r".to_string(),
            id: "p".to_string(),
            x: f32::NAN,
            y: 0.0,
        };
        let err = decode_cursor(&encode_cursor(&nan)).unwrap_err();
        assert!(err.contains("non-finite"), "got: {err}");
    }

    #[test]
    fn decode_ignores_unknown_fields_and_dupes_last_wins() {
        let json = r#"{"room":"r","id":"p","x":1,"y":2,"n":5,"o":{"a":[1,2]}}"#;
        assert_eq!(decode_cursor(json).unwrap().x, 1.0);
        let dupe = r#"{"room":"r","id":"p","x":1,"x":3,"y":2}"#;
        assert_eq!(decode_cursor(dupe).unwrap().x, 3.0);
    }

    #[test]
    fn oversized_datagram_is_rejected() {
        let big = vec![b'x'; MAX_CURSOR_BYTES + 1];
        assert!(decode_datagram(&big).is_err());
    }
}
