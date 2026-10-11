//! Local save: snapshot file + JSON export (std only, hermetic).
//!
//! `GameSave` carries the room id, the save version and the full
//! `RoomState` partition (one JSON token per key, the same shape
//! `src/map/tokens.ts` travels in). Rejoin restores the snapshot
//! wholesale ([`restore`]), so a guest never merges deltas twice and
//! tokens never duplicate — the invariant `e2e/room.spec.ts` checks
//! with 6 pieces.
//!
//! No `tauri`/`serde`/`rusqlite` crates yet (offline-friendly, same rule
//! as `src-tauri/src/net/`): the file backend is a length-prefixed line
//! format in `std::fs`, JSON uses a minimal structural parser in this
//! module, and [`SCHEMA_SQL`] (+ the `*_sql` helpers) documents the exact
//! SQLite mapping the `rusqlite` backend must implement — same tables and
//! rows the file backend persists. Delete the file backend in favor of
//! `rusqlite` when the Tauri bootstrap lands.

use std::collections::BTreeMap;
use std::path::Path;

/// Save format version written by this build.
pub const SAVE_VERSION: &str = "1.0";

/// SQLite schema the future `rusqlite` backend must implement.
///
/// `meta` holds one row per save (`room`, `version`); `state` holds one
/// row per `RoomState` entry (token JSON per key). The file backend below
/// persists exactly these rows; the SQL helpers emit the upserts.
pub const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);\
     CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);";

/// Quote a SQLite string literal by doubling single quotes.
pub fn sql_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Upsert the save metadata the `rusqlite` backend must execute.
pub fn meta_upsert_sql(key: &str, value: &str) -> String {
    format!(
        "INSERT INTO meta (key, value) VALUES ({}, {}) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value;",
        sql_quote(key),
        sql_quote(value)
    )
}

/// Upsert one `RoomState` entry the `rusqlite` backend must execute.
pub fn state_upsert_sql(key: &str, value: &str) -> String {
    format!(
        "INSERT INTO state (key, value) VALUES ({}, {}) \
         ON CONFLICT (key) DO UPDATE SET value = excluded.value;",
        sql_quote(key),
        sql_quote(value)
    )
}

/// A saved room: id + version + full state snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameSave {
    pub room: String,
    pub version: String,
    pub state: BTreeMap<String, String>,
}

/// Capture the snapshot the host diffuses on (re)join.
pub fn snapshot(
    room: &str,
    version: &str,
    state: &BTreeMap<String, String>,
) -> GameSave {
    GameSave {
        room: room.to_string(),
        version: version.to_string(),
        state: state.clone(),
    }
}

/// Restore a snapshot wholesale: replaces local state, never merges.
///
/// Rejoin path — applying the same snapshot twice still yields exactly
/// the saved keys, so tokens cannot duplicate.
pub fn restore(save: &GameSave) -> BTreeMap<String, String> {
    save.state.clone()
}

// --- File backend (length-prefixed, binary-safe) --------------------------
//
//   vtt-save/1\n
//   room <len>\n<room bytes>\n
//   save-version <len>\n<version bytes>\n
//   entries <n>\n
//   key <klen> value <vlen>\n<key bytes>\n<value bytes>\n   (× n)

const FILE_MAGIC: &str = "vtt-save/1";

fn read_line(data: &[u8], pos: &mut usize) -> Result<String, String> {
    let start = *pos;
    while *pos < data.len() && data[*pos] != b'\n' {
        *pos += 1;
    }
    if *pos >= data.len() {
        return Err("malformed save file: truncated line".to_string());
    }
    let line = std::str::from_utf8(&data[start..*pos])
        .map_err(|_| "malformed save file: invalid utf-8".to_string())?;
    *pos += 1; // consume '\n'
    Ok(line.to_string())
}

fn read_bytes(data: &[u8], pos: &mut usize, len: usize) -> Result<Vec<u8>, String> {
    if *pos + len > data.len() {
        return Err("malformed save file: truncated body".to_string());
    }
    let out = data[*pos..*pos + len].to_vec();
    *pos += len;
    if data.get(*pos) != Some(&b'\n') {
        return Err("malformed save file: missing newline".to_string());
    }
    *pos += 1;
    Ok(out)
}

/// Persist `save` to `path`, creating or truncating the file.
pub fn save_to_file(path: &Path, save: &GameSave) -> Result<(), String> {
    let mut out = String::new();
    out.push_str(FILE_MAGIC);
    out.push('\n');
    out.push_str(&format!("room {}\n{}\n", save.room.len(), save.room));
    out.push_str(&format!(
        "save-version {}\n{}\n",
        save.version.len(),
        save.version
    ));
    out.push_str(&format!("entries {}\n", save.state.len()));
    for (key, value) in &save.state {
        out.push_str(&format!("key {} value {}\n{}\n{}\n", key.len(), value.len(), key, value));
    }
    std::fs::write(path, out.as_bytes())
        .map_err(|e| format!("save failed: {e}"))?;
    Ok(())
}

/// Load a save from `path`; rejects unknown versions and garbage.
pub fn load_from_file(path: &Path) -> Result<GameSave, String> {
    let data = std::fs::read(path).map_err(|e| format!("load failed: {e}"))?;
    let mut pos = 0;
    if read_line(&data, &mut pos)? != FILE_MAGIC {
        return Err("malformed save file: bad magic".to_string());
    }
    let room_len: usize = read_line(&data, &mut pos)?
        .strip_prefix("room ")
        .ok_or_else(|| "malformed save file: expected room".to_string())?
        .parse()
        .map_err(|_| "malformed save file: bad room len".to_string())?;
    let room = String::from_utf8(read_bytes(&data, &mut pos, room_len)?)
        .map_err(|_| "malformed save file: invalid utf-8".to_string())?;
    let version_len: usize = read_line(&data, &mut pos)?
        .strip_prefix("save-version ")
        .ok_or_else(|| "malformed save file: expected save-version".to_string())?
        .parse()
        .map_err(|_| "malformed save file: bad version len".to_string())?;
    let version = String::from_utf8(read_bytes(&data, &mut pos, version_len)?)
        .map_err(|_| "malformed save file: invalid utf-8".to_string())?;
    if version != SAVE_VERSION {
        return Err(format!(
            "version mismatch: save={version} expected={SAVE_VERSION}"
        ));
    }
    if room.is_empty() {
        return Err("missing field: room".to_string());
    }
    let count: usize = read_line(&data, &mut pos)?
        .strip_prefix("entries ")
        .ok_or_else(|| "malformed save file: expected entries".to_string())?
        .parse()
        .map_err(|_| "malformed save file: bad entries count".to_string())?;
    let mut state = BTreeMap::new();
    for _ in 0..count {
        let header = read_line(&data, &mut pos)?;
        let (klen, vlen) = parse_entry_header(&header)?;
        let key = String::from_utf8(read_bytes(&data, &mut pos, klen)?)
            .map_err(|_| "malformed save file: invalid utf-8".to_string())?;
        let value = String::from_utf8(read_bytes(&data, &mut pos, vlen)?)
            .map_err(|_| "malformed save file: invalid utf-8".to_string())?;
        state.insert(key, value);
    }
    if pos != data.len() {
        return Err("malformed save file: trailing characters".to_string());
    }
    Ok(GameSave {
        room,
        version,
        state,
    })
}

fn parse_entry_header(header: &str) -> Result<(usize, usize), String> {
    let rest = header
        .strip_prefix("key ")
        .ok_or_else(|| "malformed save file: expected key".to_string())?;
    let (klen, rest) = rest
        .split_once(" value ")
        .ok_or_else(|| "malformed save file: expected value".to_string())?;
    let klen: usize = klen
        .parse()
        .map_err(|_| "malformed save file: bad key len".to_string())?;
    let vlen: usize = rest
        .parse()
        .map_err(|_| "malformed save file: bad value len".to_string())?;
    Ok((klen, vlen))
}

// --- JSON export (manual, std-only) ----------------------------------------
//
//   {"version":"1.0","room":"...","state":{"k":"v",...}}

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

/// Export `save` as JSON for backup/sharing between peers.
pub fn export_json(save: &GameSave) -> String {
    let mut out = String::from("{\"version\":\"");
    out.push_str(&escape_json_string(&save.version));
    out.push_str("\",\"room\":\"");
    out.push_str(&escape_json_string(&save.room));
    out.push_str("\",\"state\":{");
    let mut first = true;
    for (key, value) in &save.state {
        if !first {
            out.push(',');
        }
        first = false;
        out.push('"');
        out.push_str(&escape_json_string(key));
        out.push_str("\":\"");
        out.push_str(&escape_json_string(value));
        out.push('"');
    }
    out.push_str("}}");
    out
}

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
            Err(format!("malformed save json: expected {what}"))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect(b'"', "`\"`")?;
        let mut buf: Vec<u8> = Vec::new();
        loop {
            let byte = self
                .peek()
                .ok_or_else(|| "malformed save json: unterminated string".to_string())?;
            self.pos += 1;
            match byte {
                b'"' => break,
                b'\\' => {
                    let esc = self
                        .peek()
                        .ok_or_else(|| "malformed save json: unterminated escape".to_string())?;
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
                            let ch = char::from_u32(code).ok_or_else(|| {
                                "malformed save json: bad \\u escape".to_string()
                            })?;
                            let mut tmp = [0u8; 4];
                            buf.extend_from_slice(ch.encode_utf8(&mut tmp).as_bytes());
                        }
                        _ => {
                            return Err(
                                "malformed save json: invalid escape".to_string()
                            );
                        }
                    }
                }
                0x00..=0x1F => {
                    return Err(
                        "malformed save json: unescaped control char".to_string()
                    );
                }
                _ => buf.push(byte),
            }
        }
        String::from_utf8(buf)
            .map_err(|_| "malformed save json: invalid utf-8".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        if self.pos + 4 > self.bytes.len() {
            return Err("malformed save json: truncated \\u escape".to_string());
        }
        let digits = &self.bytes[self.pos..self.pos + 4];
        let text = std::str::from_utf8(digits)
            .map_err(|_| "malformed save json: bad \\u escape".to_string())?;
        let code = u32::from_str_radix(text, 16)
            .map_err(|_| "malformed save json: bad \\u escape".to_string())?;
        self.pos += 4;
        Ok(code)
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
                            "malformed save json: expected string key".to_string()
                        );
                    }
                    self.parse_string()?;
                    self.skip_ws();
                    self.expect(b':', "`:`")?;
                    self.skip_value()?;
                    self.skip_ws();
                    match self.peek() {
                        Some(b',') => self.pos += 1,
                        Some(b'}') => {
                            self.pos += 1;
                            return Ok(());
                        }
                        _ => {
                            return Err(
                                "malformed save json: expected `,` or `}`".to_string()
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
                        Some(b',') => self.pos += 1,
                        Some(b']') => {
                            self.pos += 1;
                            return Ok(());
                        }
                        _ => {
                            return Err(
                                "malformed save json: expected `,` or `]`".to_string()
                            );
                        }
                    }
                }
            }
            Some(c)
                if c.is_ascii_alphanumeric()
                    || c == b'-'
                    || c == b'.'
                    || c == b'+' =>
            {
                while let Some(c) = self.peek() {
                    if c.is_ascii_alphanumeric() || c == b'-' || c == b'+' || c == b'.' {
                        self.pos += 1;
                    } else {
                        break;
                    }
                }
                Ok(())
            }
            _ => Err("malformed save json: bad value".to_string()),
        }
    }

    /// Parse `{"version","room","state"}`; unknown fields ignored, dupes last-wins.
    fn parse_save(mut self) -> Result<GameSave, String> {
        self.skip_ws();
        self.expect(b'{', "`{`")?;
        let mut version: Option<String> = None;
        let mut room: Option<String> = None;
        let mut state: Option<BTreeMap<String, String>> = None;
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
        } else {
            loop {
                self.skip_ws();
                if self.peek() != Some(b'"') {
                    return Err(
                        "malformed save json: expected string key".to_string()
                    );
                }
                let key = self.parse_string()?;
                self.skip_ws();
                self.expect(b':', "`:`")?;
                self.skip_ws();
                match key.as_str() {
                    "version" | "room" => {
                        if self.peek() != Some(b'"') {
                            return Err(format!("missing field: {key}"));
                        }
                        let value = self.parse_string()?;
                        if key == "version" {
                            version = Some(value);
                        } else {
                            room = Some(value);
                        }
                    }
                    "state" => {
                        self.expect(b'{', "`{`")?;
                        let mut map = BTreeMap::new();
                        self.skip_ws();
                        if self.peek() == Some(b'}') {
                            self.pos += 1;
                        } else {
                            loop {
                                self.skip_ws();
                                if self.peek() != Some(b'"') {
                                    return Err(
                                        "malformed save json: expected string key"
                                            .to_string(),
                                    );
                                }
                                let k = self.parse_string()?;
                                self.skip_ws();
                                self.expect(b':', "`:`")?;
                                self.skip_ws();
                                if self.peek() != Some(b'"') {
                                    return Err(
                                        "malformed save json: state values must be strings"
                                            .to_string(),
                                    );
                                }
                                let v = self.parse_string()?;
                                map.insert(k, v);
                                self.skip_ws();
                                match self.peek() {
                                    Some(b',') => self.pos += 1,
                                    Some(b'}') => {
                                        self.pos += 1;
                                        break;
                                    }
                                    _ => {
                                        return Err(
                                            "malformed save json: expected `,` or `}`"
                                                .to_string(),
                                        );
                                    }
                                }
                            }
                        }
                        state = Some(map);
                    }
                    _ => {
                        self.skip_value()?;
                    }
                }
                self.skip_ws();
                match self.peek() {
                    Some(b',') => self.pos += 1,
                    Some(b'}') => {
                        self.pos += 1;
                        break;
                    }
                    _ => {
                        return Err(
                            "malformed save json: expected `,` or `}`".to_string()
                        );
                    }
                }
            }
        }
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err("malformed save json: trailing characters".to_string());
        }
        let version = version.ok_or_else(|| "missing field: version".to_string())?;
        if version != SAVE_VERSION {
            return Err(format!(
                "version mismatch: save={version} expected={SAVE_VERSION}"
            ));
        }
        let room = room.ok_or_else(|| "missing field: room".to_string())?;
        if room.is_empty() {
            return Err("missing field: room".to_string());
        }
        let state = state.ok_or_else(|| "missing field: state".to_string())?;
        Ok(GameSave {
            room,
            version,
            state,
        })
    }
}

/// Import a save from its JSON export form; version-checked.
pub fn import_json(json: &str) -> Result<GameSave, String> {
    JsonParser::new(json).parse_save()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn six_token_state() -> BTreeMap<String, String> {
        let mut state = BTreeMap::new();
        for (i, id) in ["dm", "p1", "p2", "p3", "p4", "p5"].iter().enumerate() {
            state.insert(
                id.to_string(),
                format!(
                    "{{\"id\":\"{id}\",\"pos\":{{\"x\":{i},\"y\":0}},\"hp\":{}}}",
                    10 + i
                ),
            );
        }
        state
    }

    fn temp_path() -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "vtt-save-test-{}-{n}.sav",
            std::process::id()
        ))
    }

    #[test]
    fn restore_replaces_wholesale_without_dup_tokens() {
        let save = snapshot("room-7000", SAVE_VERSION, &six_token_state());
        // Guest cai e recebe o snapshot duas vezes: nunca duplica.
        let mut local = restore(&save);
        assert_eq!(local.len(), 6);
        local = restore(&save);
        assert_eq!(local.len(), 6);
        let mut ids: Vec<&String> = local.keys().collect();
        ids.sort();
        assert_eq!(ids, vec!["dm", "p1", "p2", "p3", "p4", "p5"]);
    }

    #[test]
    fn file_roundtrip_preserves_all_fields() {
        let mut state = six_token_state();
        state.insert(
            "weird \"key\" \\ é".to_string(),
            "line1\nline2\tünïcodé\\".to_string(),
        );
        let save = snapshot("weird \"room\" \\ name", SAVE_VERSION, &state);
        let path = temp_path();
        save_to_file(&path, &save).unwrap();
        let back = load_from_file(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(back, save);
        assert_eq!(back.state.len(), 7);
    }

    #[test]
    fn file_rejects_garbage_and_truncation() {
        let path = temp_path();
        for bad in [
            "not a save file\n",
            "vtt-save/1\nroom 3\nabc", // truncated body
            "vtt-save/1\nroom x\n",    // bad len
            "vtt-save/1\n",            // truncated header
            "vtt-save/2\n",            // bad magic
            "",                        // empty
        ] {
            std::fs::write(&path, bad).unwrap();
            assert!(load_from_file(&path).is_err(), "accepted: {bad:?}");
        }
        // Trailing garbage após entries válidas.
        let save = snapshot("room-7000", SAVE_VERSION, &six_token_state());
        save_to_file(&path, &save).unwrap();
        let mut bytes = std::fs::read(&path).unwrap();
        bytes.extend_from_slice(b"extra\n");
        std::fs::write(&path, &bytes).unwrap();
        assert!(load_from_file(&path).is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn file_rejects_future_version() {
        let save = snapshot("room-7000", "9.9", &six_token_state());
        let path = temp_path();
        save_to_file(&path, &save).unwrap();
        let err = load_from_file(&path).unwrap_err();
        assert!(err.contains("version mismatch"), "got: {err}");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn load_missing_file_errors() {
        let err = load_from_file(Path::new("/nonexistent-dir-vtt/missing.sav"))
            .unwrap_err();
        assert!(err.contains("load failed"), "got: {err}");
    }

    #[test]
    fn json_roundtrip_escapes_everything() {
        let mut state = six_token_state();
        state.insert(
            "weird \"key\" \\ é".to_string(),
            "quote \" backslash \\ newline \n tab \t ctrl \u{1}".to_string(),
        );
        let save = snapshot("weird \"room\" \\ name\n\té", SAVE_VERSION, &state);
        let wire = export_json(&save);
        assert!(wire.contains("\\\"room\\\""));
        assert!(wire.contains("\\\\"));
        // JSON válido de verdade: checa chaves estruturais.
        assert!(wire.starts_with("{\"version\":\"1.0\",\"room\":"));
        assert!(wire.contains("\"state\":{"));
        let back = import_json(&wire).unwrap();
        assert_eq!(back, save);
    }

    #[test]
    fn json_rejects_malformed_missing_and_version() {
        let good = export_json(&snapshot("r", SAVE_VERSION, &six_token_state()));
        let cases: Vec<(String, &str)> = vec![
            ("not json".to_string(), "malformed"),
            ("".to_string(), "malformed"),
            ("[1,2]".to_string(), "malformed"),
            (good.clone() + "trailing", "trailing"),
            (
                r#"{"version":"1.0","room":"r"}"#.to_string(),
                "missing field: state",
            ),
            (
                r#"{"room":"r","state":{}}"#.to_string(),
                "missing field: version",
            ),
            (
                r#"{"version":"0.9","room":"r","state":{}}"#.to_string(),
                "version mismatch",
            ),
            (
                r#"{"version":"1.0","room":"","state":{}}"#.to_string(),
                "missing field: room",
            ),
            (
                r#"{"version":"1.0","room":"r","state":{"k":5}}"#.to_string(),
                "must be strings",
            ),
            (
                r#"{"version":"1.0","room":"r","state":{}}"#.to_string() + ",",
                "trailing",
            ),
        ];
        for (bad, want) in cases {
            let err = import_json(&bad).unwrap_err();
            assert!(err.contains(want), "input {bad:?} gave: {err}");
        }
    }

    #[test]
    fn json_ignores_extra_fields_and_dupes_last_wins() {
        let json = "{\"version\":\"1.0\",\"room\":\"r\",\"state\":{\"k\":\"v\"},\"n\":5,\"o\":{\"a\":[1,2]}}";
        let save = import_json(json).unwrap();
        assert_eq!(save.state.get("k"), Some(&"v".to_string()));
        let dupe = r#"{"version":"1.0","room":"a","room":"b","state":{}}"#;
        assert_eq!(import_json(dupe).unwrap().room, "b");
    }

    #[test]
    fn sql_helpers_quote_single_quotes() {
        assert_eq!(sql_quote("O'Brien"), "'O''Brien'");
        let meta = meta_upsert_sql("room", "weird 'room'");
        assert!(meta.contains("INSERT INTO meta"), "got: {meta}");
        assert!(meta.contains("'weird ''room'''"), "got: {meta}");
        let entry = state_upsert_sql("dm", "{\"hp\":10}");
        assert!(entry.contains("INSERT INTO state"), "got: {entry}");
        assert!(entry.contains("ON CONFLICT (key)"), "got: {entry}");
        assert!(SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS meta"));
        assert!(SCHEMA_SQL.contains("CREATE TABLE IF NOT EXISTS state"));
    }
}
