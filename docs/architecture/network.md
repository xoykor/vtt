# Network

## Responsabilidades

Protocolo de sala P2P: handshake com versionamento, validação de endereço, aplicação de deltas de estado e transporte TCP real com framing length-prefixed. Define a divisão de canais entre TCP (estado crítico) e UDP (cursor/luz).

## Arquivos

- `src/net/peer.ts` — espelho TS do protocolo (handshake, `applyDelta`, `parseRoomAddr`, `createRoom`, `joinRoom`).
- `src-tauri/src/net/mod.rs` — espelho Rust: `RoomInfo`, `Peer`, `Delta`, `create_room`, `join_room`, `apply_delta`.
- `src-tauri/src/net/proto.rs` — `Handshake`, `Role`, `Channel`, `PROTOCOL_VERSION`, `MDNS_SERVICE`, encode/decode handshake, parser JSON std-only.
- `src-tauri/src/net/tcp.rs` — TCP real (tokio): `serve_once`, `connect_handshake`, `send/recv_snapshot`, `send/recv_delta`, framing `u32` BE.

## Interfaces principais

```ts
// src/net/peer.ts
export const PROTOCOL_VERSION = "1.0";
export const MDNS_SERVICE = "_vtt._tcp";
export type Role = "host" | "guest";
export type Channel = "tcp-state" | "udp-cursor";
export interface Handshake { version: string; room: string; role: Role; }
export function handshake(peerVersion: string, expected: string): void;
export function encodeHandshake(h: Handshake): string;
export function decodeHandshake(json: string): Handshake;
export function parseRoomAddr(addr: string): RoomAddr;
export function createRoom(port: number): RoomInfo;
export function joinRoom(ip: string, port: number): Peer;
export type RoomState = Record<string, string>;
export interface Delta { upsert?: Record<string, string>; remove?: string[]; }
export function applyDelta(state: RoomState, delta: Delta): RoomState;
```

```rust
// src-tauri/src/net/mod.rs
pub struct RoomInfo { pub room: String, pub port: u16, pub version: String }
pub struct Peer { pub ip: String, pub port: u16, pub role: Role }
pub struct Delta { pub upsert: Vec<(String, String)>, pub remove: Vec<String> }
pub fn create_room(port: u16) -> Result<RoomInfo, String>;
pub fn join_room(ip: &str, port: u16) -> Result<Peer, String>;
pub fn apply_delta(state: &BTreeMap<String, String>, delta: &Delta) -> BTreeMap<String, String>;
```

```rust
// src-tauri/src/net/tcp.rs
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
pub async fn serve_once(listener: TcpListener) -> Result<Handshake, String>;
pub async fn connect_handshake(addr: SocketAddr) -> Result<RoomInfo, String>;
pub async fn send_snapshot(stream: &mut TcpStream, save: &GameSave) -> Result<(), String>;
pub async fn recv_snapshot(stream: &mut TcpStream) -> Result<GameSave, String>;
pub async fn send_delta(stream: &mut TcpStream, delta: &Delta) -> Result<(), String>;
pub async fn recv_delta(stream: &mut TcpStream) -> Result<Delta, String>;
```

## Decisões

- **Handshake JSON** com `version`, `room`, `role`. Versão diferente rejeita fail-closed (host fecha sem reply frame; EOF é o sinal de rejeição).
- **Framing TCP**: `u32` big-endian length + payload, cap 1 MiB. Snapshots de token state são KiB-scale; assets viajão out-of-band por hash.
- **Snapshot cheio no join, depois deltas**: guest recebe `export_json` shape e aplica via `applyDelta` (replace, nunca merge — rejoin nunca duplica).
- **Remove-wins**: `applyDelta` aplica upserts primeiro, depois removes; chave em ambos é deletada.
- **Timeouts fail-closed**: accept, connect e handshake reads capped em 10s. Sem `.expect`/`.unwrap` em caminho de rede — tudo `Result<_, String>`.
- **RoomState particionado**: `token:<id>`, `tile:<layer>:<x>,<y>`, `roll:<id>`, `sheet:<id>`. Deltas de roll/sheet não poluem `tokenCount()`.

## Pendências

- **UDP cursor/luz**: `Channel::UdpCursor` definido no protocolo, sem implementação de socket (Fase 3 Task 6).
- **mDNS**: `MDNS_SERVICE = "_vtt._tcp"` definido, sem announce/discover (Fase 3 Task 6).
- **Delta shape divergence**: Rust `Delta` exige `upsert`/`remove` como vecs obrigatórios; TS usa campos opcionais. Bridge FFI deve adaptar.
- **Sem retry/reconexão**: guest que cai precisa reconecta manualmente; auto-reconnect é escopo futuro.
