//! Standalone VTT host (Fase 3, Task 5): real TCP room without Tauri.
//!
//! Serves one room over TCP on loopback/LAN: handshake (same wire
//! sequence as [`vtt_tauri::net::tcp::serve_once`] — read one handshake
//! frame, version-gate it, reply with one room frame) and then, unlike
//! `serve_once` which drops the stream after the reply, the connection
//! stays open for the snapshot/delta loop: the host diffuses the full
//! snapshot ([`vtt_tauri::save::export_json`] shape) on (re)join and
//! applies every guest delta ([`vtt_tauri::net::tcp::decode_delta`],
//! remove-wins) before echoing the updated snapshot.
//!
//! Rejection policy (mirrors `tcp.rs`): a stale/malformed handshake or a
//! room mismatch closes the connection with NO reply frame — the guest's
//! pending read fails with EOF (`tcp read failed`), which IS the
//! rejection signal. Both sides surface `Err`, never a hang.
//!
//! Usage: `host [--bind 127.0.0.1] [--port 7000] [--room room-7000]`
//! (positional `host [port] [room]` also works). `--port 0` binds an
//! ephemeral port for hermetic tests; the host prints exactly one line
//! to stdout once listening — `HOST_READY port=<actual> room=<room>` —
//! so a parent process can discover the port. Logs go to stderr; stdout
//! stays machine-readable. Runs until killed.

use std::collections::BTreeMap;
use std::io::Write as _;
use std::sync::{Arc, Mutex};

use tokio::net::{TcpListener, TcpStream};
use vtt_tauri::net::tcp::{
    decode_room_info, encode_room_info, recv_delta, recv_frame, send_frame,
    send_snapshot,
};
use vtt_tauri::net::{apply_delta, decode_handshake, encode_handshake};
use vtt_tauri::save::{snapshot, SAVE_VERSION};

/// Parsed CLI: bind ip, port (`0` = ephemeral, discovered via the
/// `HOST_READY` stdout line) and the authoritative room id (`None` =
/// default `room-<actual-port>` once bound).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Config {
    bind: String,
    port: u16,
    room: Option<String>,
}

impl Default for Config {
    fn default() -> Config {
        Config {
            bind: "127.0.0.1".to_string(),
            port: 7000,
            room: None,
        }
    }
}

const USAGE: &str = "usage: host [--bind <ip>] [--port <u16>] [--room <name>] | host [port] [room]";

/// Parse `argv` (without the program name), std-only, no new deps.
/// Flags win over positionals; `--help`/`-h` is a usage request.
fn parse_args(argv: &[String]) -> Result<Config, String> {
    let mut cfg = Config::default();
    let mut positionals: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        match argv[i].as_str() {
            "-h" | "--help" => return Err("help".to_string()),
            "-p" | "--port" => {
                i += 1;
                let raw = argv.get(i).ok_or_else(|| {
                    format!("missing value for --port\n{USAGE}")
                })?;
                cfg.port = raw.parse::<u16>().map_err(|_| {
                    format!("invalid port: {raw} (use 0-65535)\n{USAGE}")
                })?;
            }
            "--bind" => {
                i += 1;
                cfg.bind = argv
                    .get(i)
                    .ok_or_else(|| {
                        format!("missing value for --bind\n{USAGE}")
                    })?
                    .clone();
            }
            "--room" => {
                i += 1;
                let room = argv
                    .get(i)
                    .ok_or_else(|| {
                        format!("missing value for --room\n{USAGE}")
                    })?
                    .clone();
                if room.is_empty() {
                    return Err(format!("missing field: room\n{USAGE}"));
                }
                cfg.room = Some(room);
            }
            other if other.starts_with('-') => {
                return Err(format!("unknown flag: {other}\n{USAGE}"));
            }
            pos => positionals.push(pos),
        }
        i += 1;
    }
    if positionals.len() > 2 {
        return Err(format!("too many arguments\n{USAGE}"));
    }
    if let Some(raw) = positionals.first() {
        cfg.port = raw.parse::<u16>().map_err(|_| {
            format!("invalid port: {raw} (use 0-65535)\n{USAGE}")
        })?;
    }
    if let Some(room) = positionals.get(1) {
        if room.is_empty() {
            return Err(format!("missing field: room\n{USAGE}"));
        }
        cfg.room = Some(room.to_string());
    }
    Ok(cfg)
}

/// Seed state the host diffuses on (re)join: 6 tokens, 1 mestre +
/// 5 jogadores (`dm` + `p1..p5`), one JSON value per key — the same
/// shape `src-tauri/src/save.rs` tests and `src/net/peer.ts` travel in.
fn seed_state() -> BTreeMap<String, String> {
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

/// One guest session on an accepted stream: handshake → room reply →
/// snapshot → delta loop (apply + echo updated snapshot) until the
/// guest goes away. Fail-closed throughout: any error closes this
/// connection only; the accept loop keeps serving.
async fn serve_session(
    mut stream: TcpStream,
    peer: std::net::SocketAddr,
    room: &str,
    port: u16,
    // `std` mutex with short critical sections (never held across
    // `.await`): cloning the state under the lock keeps the `sync`
    // tokio feature — and a new dep edge — out of this binary.
    shared: Arc<Mutex<BTreeMap<String, String>>>,
) {
    let frame = match recv_frame(&mut stream).await {
        Ok(frame) => frame,
        Err(e) => {
            eprintln!("host: [{peer}] handshake read failed: {e}");
            return;
        }
    };
    let text = match std::str::from_utf8(&frame) {
        Ok(text) => text,
        Err(_) => {
            eprintln!("host: [{peer}] malformed handshake: invalid utf-8");
            return;
        }
    };
    let hs = match decode_handshake(text) {
        Ok(hs) => hs,
        Err(e) => {
            // No reply frame: EOF-after-handshake is the rejection.
            eprintln!("host: [{peer}] handshake rejected: {e}");
            return;
        }
    };
    if hs.room != room {
        eprintln!(
            "host: [{peer}] room mismatch: guest={} expected={room}",
            hs.room
        );
        return;
    }
    let info = vtt_tauri::net::RoomInfo {
        room: room.to_string(),
        port,
        version: vtt_tauri::net::PROTOCOL_VERSION.to_string(),
    };
    if let Err(e) =
        send_frame(&mut stream, encode_room_info(&info).as_bytes()).await
    {
        eprintln!("host: [{peer}] room reply failed: {e}");
        return;
    }
    {
        let save = match shared.lock() {
            Ok(state) => snapshot(room, SAVE_VERSION, &state),
            Err(_) => {
                eprintln!("host: [{peer}] state lock poisoned");
                return;
            }
        };
        if let Err(e) = send_snapshot(&mut stream, &save).await {
            eprintln!("host: [{peer}] snapshot send failed: {e}");
            return;
        }
    }
    loop {
        let delta = match recv_delta(&mut stream).await {
            Ok(delta) => delta,
            Err(e) => {
                eprintln!("host: [{peer}] session ended: {e}");
                return;
            }
        };
        let save = match shared.lock() {
            Ok(mut state) => {
                *state = apply_delta(&state, &delta);
                snapshot(room, SAVE_VERSION, &state)
            }
            Err(_) => {
                eprintln!("host: [{peer}] state lock poisoned");
                return;
            }
        };
        if let Err(e) = send_snapshot(&mut stream, &save).await {
            eprintln!("host: [{peer}] snapshot send failed: {e}");
            return;
        }
    }
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let cfg = match parse_args(&argv) {
        Ok(cfg) => cfg,
        Err(e) if e == "help" => {
            println!("{USAGE}");
            return;
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let listener = match TcpListener::bind(format!("{}:{}", cfg.bind, cfg.port))
        .await
    {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("host: bind failed [{}:{}]: {e}", cfg.bind, cfg.port);
            std::process::exit(1);
        }
    };
    let actual_port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            eprintln!("host: local_addr failed: {e}");
            std::process::exit(1);
        }
    };
    let room =
        cfg.room.clone().unwrap_or_else(|| format!("room-{actual_port}"));
    // The ONLY stdout line: machine-readable readiness for the parent
    // (tests spawn with `--port 0` and parse this). Flush explicitly:
    // piped stdout is block-buffered, `println!` alone may never arrive.
    println!("HOST_READY port={actual_port} room={room}");
    if std::io::stdout().flush().is_err() {
        eprintln!("host: stdout flush failed");
        std::process::exit(1);
    }
    eprintln!("host: serving room {room} on {actual_port}");
    // Log the expected handshake shape once (proves the guest side's
    // `encode_handshake` target without affecting the wire).
    eprintln!(
        "host: expect {}",
        encode_handshake(&vtt_tauri::net::Handshake {
            version: vtt_tauri::net::PROTOCOL_VERSION.to_string(),
            room: room.clone(),
            role: vtt_tauri::net::Role::Guest,
        })
    );
    // Touch `decode_room_info`'s import so the reply codec stays honest
    // (self-check: our own reply must always parse).
    debug_assert!(
        decode_room_info(&encode_room_info(&vtt_tauri::net::RoomInfo {
            room: room.clone(),
            port: actual_port,
            version: vtt_tauri::net::PROTOCOL_VERSION.to_string(),
        }))
        .is_ok()
    );
    let shared = Arc::new(Mutex::new(seed_state()));
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("host: accept failed: {e}");
                continue;
            }
        };
        let shared = Arc::clone(&shared);
        let room = room.clone();
        tokio::spawn(async move {
            serve_session(stream, peer, &room, actual_port, shared).await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|w| w.to_string()).collect()
    }

    #[test]
    fn defaults_bind_loopback_and_port_7000() {
        assert_eq!(parse_args(&args(&[])).expect("defaults"), Config {
            bind: "127.0.0.1".to_string(),
            port: 7000,
            room: None,
        });
    }

    #[test]
    fn flags_set_port_room_and_bind() {
        let cfg = parse_args(&args(&[
            "--bind", "0.0.0.0", "--port", "0", "--room", "room-x",
        ]))
        .expect("flags");
        assert_eq!(cfg.bind, "0.0.0.0");
        assert_eq!(cfg.port, 0);
        assert_eq!(cfg.room.as_deref(), Some("room-x"));
    }

    #[test]
    fn positionals_set_port_then_room() {
        let cfg =
            parse_args(&args(&["7001", "room-7001"])).expect("positionals");
        assert_eq!(cfg.port, 7001);
        assert_eq!(cfg.room.as_deref(), Some("room-7001"));
    }

    #[test]
    fn rejects_bad_port_unknown_flag_and_empty_room() {
        assert!(parse_args(&args(&["abc"])).is_err());
        assert!(parse_args(&args(&["--port"])).is_err());
        assert!(parse_args(&args(&["--nope"])).is_err());
        assert!(parse_args(&args(&["--room", ""])).is_err());
        assert!(parse_args(&args(&["1", "2", "3"])).is_err());
    }

    #[test]
    fn seed_holds_six_token_json_values() {
        let state = seed_state();
        assert_eq!(state.len(), 6);
        assert_eq!(
            state.get("dm").map(String::as_str),
            Some(r#"{"id":"dm","pos":{"x":0,"y":0},"hp":10}"#)
        );
    }
}
