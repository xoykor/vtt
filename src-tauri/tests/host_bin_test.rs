//! Task 5 interop: spawn the standalone `host` binary and talk to it
//! over real loopback TCP (consumes Task 3's `serve/connect_handshake`
//! wire format + Task 4's room/delta JSON shapes).
//!
//! Hermetic by design: the host binds `127.0.0.1:0` (ephemeral port,
//! discovered via its `HOST_READY port=… room=…` stdout line), the guest
//! dials only loopback, and the whole round-trip is capped so a hang
//! fails the test instead of the suite. The child is killed on drop,
//! even on assertion failure.
//!
//! Flow per connection (mirrors `src/bin/host.rs`): handshake → room
//! reply → snapshot → delta loop. Phase A proves the handshake through
//! the production [`connect_with_handshake`] helper; phase B keeps one
//! stream open and proves snapshot + delta travel over real TCP. A host
//! whose handshake is stale/malformed gets no reply frame — the guest
//! observes EOF, which IS the rejection signal (same policy as
//! `tcp.rs`).

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::net::TcpStream;
use vtt_tauri::net::tcp::{
    connect_with_handshake, decode_room_info, recv_frame, recv_snapshot,
    send_delta, send_frame,
};
use vtt_tauri::net::{encode_handshake, Delta, Handshake, Role, PROTOCOL_VERSION};

/// Spawned `host` child, killed (and reaped) on drop.
struct HostChild {
    child: Child,
    port: u16,
    room: String,
}

impl HostChild {
    /// Spawn `host --port 0 --room <room>` and wait for its `HOST_READY`
    /// stdout line (fail-closed after 10 s instead of hanging).
    fn spawn(room: &str) -> Result<HostChild, String> {
        let bin = env!("CARGO_BIN_EXE_host");
        let mut child = Command::new(bin)
            .args(["--bind", "127.0.0.1", "--port", "0", "--room", room])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn host failed: {e}"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "host stdout not piped".to_string())?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut lines = BufReader::new(stdout).lines();
            tx.send(lines.next().map(|r| r.unwrap_or_default()))
                .ok();
        });
        let line = rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "host readiness timed out after 10s".to_string())?
            .ok_or_else(|| "host closed stdout without HOST_READY".to_string())?;
        let (port, ready_room) = parse_ready(&line)?;
        if ready_room != room {
            return Err(format!(
                "host room mismatch: ready={ready_room} expected={room}"
            ));
        }
        Ok(HostChild {
            child,
            port,
            room: ready_room,
        })
    }

    fn addr(&self) -> std::net::SocketAddr {
        format!("127.0.0.1:{}", self.port)
            .parse()
            .expect("loopback addr parses")
    }
}

impl Drop for HostChild {
    fn drop(&mut self) {
        self.child.kill().ok();
        self.child.wait().ok();
    }
}

/// Parse `HOST_READY port=<u16> room=<name>` (the binary's only stdout
/// line); anything else is a protocol violation.
fn parse_ready(line: &str) -> Result<(u16, String), String> {
    let rest =
        line.strip_prefix("HOST_READY ").ok_or_else(|| {
            format!("malformed HOST_READY line: {line:?}")
        })?;
    let mut port: Option<u16> = None;
    let mut room: Option<&str> = None;
    for part in rest.split(' ') {
        if let Some(raw) = part.strip_prefix("port=") {
            port = Some(
                raw.parse::<u16>()
                    .map_err(|_| format!("malformed HOST_READY port: {line:?}"))?,
            );
        } else if let Some(name) = part.strip_prefix("room=") {
            room = Some(name);
        }
    }
    match (port, room) {
        (Some(port), Some(room)) if port != 0 && !room.is_empty() => {
            Ok((port, room.to_string()))
        }
        _ => Err(format!("malformed HOST_READY line: {line:?}")),
    }
}

fn guest_for(room: &str) -> Handshake {
    Handshake {
        version: PROTOCOL_VERSION.to_string(),
        room: room.to_string(),
        role: Role::Guest,
    }
}

/// Full guest session on ONE kept-open stream: handshake → room reply →
/// snapshot → delta → updated snapshot. Retries ONLY transient
/// transport failures (connect/handshake read/write): a previous probe
/// connection (phase A) may still be draining on the host. Deterministic
/// validation mismatches (room reply, snapshot shape, version gate)
/// fail fast — retrying them only sleeps 10 s and masks the real error.
async fn guest_session(
    addr: std::net::SocketAddr,
    room: &str,
) -> Result<(vtt_tauri::save::GameSave, vtt_tauri::save::GameSave), String>
{
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut first_err: Option<String> = None;
    loop {
        match guest_session_once(addr, room).await {
            Ok(pair) => return Ok(pair),
            Err(e) => {
                if !is_transient(&e) {
                    return Err(e);
                }
                if first_err.is_none() {
                    first_err = Some(e);
                }
                if std::time::Instant::now() >= deadline {
                    return Err(first_err
                        .expect("transient error implies first_err is set"));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        }
    }
}

/// Transient transport failures worth one more dial: connect timeouts,
/// handshake timeouts and read/write EOFs. Everything else (room reply
/// mismatch, snapshot shape, version gate, malformed JSON) is
/// deterministic and must fail fast.
fn is_transient(err: &str) -> bool {
    err.starts_with("tcp connect")
        || err.starts_with("tcp handshake")
        || err.starts_with("tcp read failed")
        || err.starts_with("tcp write failed")
}

async fn guest_session_once(
    addr: std::net::SocketAddr,
    room: &str,
) -> Result<(vtt_tauri::save::GameSave, vtt_tauri::save::GameSave), String>
{
    let mut stream =
        TcpStream::connect(addr).await.map_err(|e| format!("tcp connect failed [{addr}]: {e}"))?;
    send_frame(&mut stream, encode_handshake(&guest_for(room)).as_bytes())
        .await?;
    let reply = recv_frame(&mut stream).await?;
    let reply_text = std::str::from_utf8(&reply)
        .map_err(|_| "malformed room json: invalid utf-8".to_string())?;
    let info = decode_room_info(reply_text)?;
    if info.room != room || info.port != addr.port() {
        return Err(format!(
            "room reply mismatch: got {}:{} expected {room}:{}",
            info.room,
            info.port,
            addr.port()
        ));
    }
    let before = recv_snapshot(&mut stream).await?;
    if before.room != room || before.state.len() != 6 {
        return Err(format!(
            "snapshot mismatch: room={} keys={}",
            before.room,
            before.state.len()
        ));
    }
    let delta = Delta {
        upsert: vec![(
            "p6".to_string(),
            r#"{"id":"p6","pos":{"x":6,"y":0},"hp":16}"#.to_string(),
        )],
        remove: vec!["p5".to_string()],
    };
    send_delta(&mut stream, &delta).await?;
    let after = recv_snapshot(&mut stream).await?;
    Ok((before, after))
}

/// Phase A (handshake via the production helper) + phase B (snapshot +
/// delta over one kept-open stream) against the real binary.
async fn interop_roundtrip() -> Result<(), String> {
    let host = HostChild::spawn("room-interop")?;
    let addr = host.addr();
    // Phase A: handshake through `connect_with_handshake`, the same call
    // the Tauri `join_room` command runs (commands.rs `join_live`).
    let info =
        connect_with_handshake(addr, &guest_for(&host.room)).await?;
    assert_eq!(info.room, host.room);
    assert_eq!(info.port, host.port);
    assert_eq!(info.version, PROTOCOL_VERSION);
    // Phase B: snapshot + delta on a persistent stream.
    let (before, after) = guest_session(addr, &host.room).await?;
    for id in ["dm", "p1", "p2", "p3", "p4", "p5"] {
        if !before.state.contains_key(id) {
            return Err(format!("snapshot missing token: {id}"));
        }
    }
    if after.state.contains_key("p5") {
        return Err("delta remove lost: p5 still present".to_string());
    }
    match after.state.get("p6").map(String::as_str) {
        Some(r#"{"id":"p6","pos":{"x":6,"y":0},"hp":16}"#) => {}
        other => return Err(format!("delta upsert lost: p6={other:?}")),
    }
    if after.state.len() != 6 {
        return Err(format!(
            "expected 6 keys after delta, got {}",
            after.state.len()
        ));
    }
    Ok(())
}

#[tokio::test]
async fn host_bin_serves_snapshot_and_delta_over_tcp() {
    tokio::time::timeout(Duration::from_secs(60), interop_roundtrip())
        .await
        .expect("interop round-trip hung")
        .expect("interop round-trip failed");
}

#[tokio::test]
async fn host_bin_rejects_stale_handshake_without_reply() {
    let host =
        HostChild::spawn("room-interop-stale").expect("spawn host");
    let addr = host.addr();
    let stale = Handshake {
        version: "0.9".to_string(),
        room: host.room.clone(),
        role: Role::Guest,
    };
    // Raw frames (not `connect_with_handshake`): the rejection must
    // surface as EOF on the pending room-reply read, never a frame.
    let mut stream = tokio::time::timeout(
        Duration::from_secs(10),
        TcpStream::connect(addr),
    )
    .await
    .expect("connect hung")
    .expect("connect failed");
    send_frame(&mut stream, encode_handshake(&stale).as_bytes())
        .await
        .expect("send stale handshake");
    let err = tokio::time::timeout(Duration::from_secs(10), recv_frame(
        &mut stream,
    ))
    .await
    .expect("reply read hung")
    .expect_err("stale handshake must get no reply frame");
    assert!(
        err.contains("tcp read failed")
            || err.to_lowercase().contains("eof")
            || err.to_lowercase().contains("closed")
            || err.to_lowercase().contains("reset")
            || err.to_lowercase().contains("broken pipe"),
        "unexpected rejection shape: {err}"
    );
}

#[test]
fn ready_line_parses_port_and_room() {
    assert_eq!(
        parse_ready("HOST_READY port=1234 room=room-x").expect("valid"),
        (1234, "room-x".to_string())
    );
    assert!(parse_ready("READY port=1 room=r").is_err());
    assert!(parse_ready("HOST_READY port=0 room=r").is_err());
    assert!(parse_ready("HOST_READY port=1 room=").is_err());
    assert!(parse_ready("HOST_READY port=abc room=r").is_err());
}
