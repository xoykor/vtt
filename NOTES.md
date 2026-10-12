# VTT — Mesa de D&D 5e P2P

## Visão geral

App Tauri 2 + Vite + TypeScript para mesa de D&D 5e P2P (mestre + 5 jogadores), com um código só para Windows, Linux, Mac e Android APK. iOS fica de fora (conta Apple paga quebraria a restrição de distribuição grátis). Sem servidor central: hospedagem via IP:porta ou mDNS em LAN/ZeroTier/Radmin/Hamachi.

## Status por fase

### Fase 1 — Núcleo (completa)

Módulos puros e herméticos em TS e Rust, sem sockets nem UI:

- `src/net/peer.ts` — protocolo de sala: handshake JSON (`version`, `room`, `role`), `createRoom`, `joinRoom`, `parseRoomAddr`, `applyDelta` (remove-wins).
- `src/map/` — grid, fog (ray-casting point-in-polygon), luz (raycasting por amostragem), tokens (`moveToken` fail-closed por role), editor de tiles (`placeTile` só host, assets por SHA-256).
- `src/sheet/` — tipos D&D (`Sheet`, `Roll`), import SRD via Open5e/5e SRD API (mapa `armor_class`, `hit_points`), cache local, `encodeSheet`/`decodeSheet`.
- `src/dice/` — `resolveRoll` (host autoritário, RNG injetável), `publishRoll`/`encodeRollResult`, cena stub (`frameForResult`, `createDiceScene`) sem Three.js.
- `src-tauri/src/net/` — espelho Rust do protocolo (handshake, `applyDelta`, `Delta` com vecs obrigatórios).
- `src-tauri/src/assets.rs` — SHA-256 manual, `verify_asset`, `AssetCache`.
- `src-tauri/src/save.rs` — save file (framing length-prefixed `vtt-save/1`), export/import JSON.

### Fase 2 — Shell jogável (completa)

- `src/app.ts` — `startApp(root)`: menu (Hospedar/Entrar/Criar Ficha) + app (canvas mapa, painel ficha, painel dado). Detecta `window.__TAURI__` e usa invoke real ou offline.
- `src/ui/room.ts` — `OfflineRoom` (host simulado local), `joinVia` (bridge invoke), `replaceDelta` (snapshot wholesale), `guestJoinNotice`.
- `src/ui/mapview.ts` — canvas 2D: grid + fog + luz + tokens (círculos rotulados).
- `src/ui/editor-panel.ts` — painel de mapa host-only: seletor de camada (floor/wall/asset), `placeTile` real, lista de tiles.
- `src-tauri/src/net/tcp.rs` — TCP real (tokio): framing `u32` BE length-prefixed, `serve_once`, `connect_handshake`, `send/recv_snapshot`, `send/recv_delta`. Timeouts fail-closed (10s), EOF = rejeição.
- `src-tauri/src/commands.rs` — bridge invoke: `create_room`, `join_room` (TCP real), `push_delta`, `get_snapshot`. `RoomStore` autoritativo.
- `src-tauri/src/lib.rs` — lib root, feature `tauri-app` default-off (crates.io bloqueado no sandbox local).
- `src-tauri/src/save.rs` — backend SQLite (rusqlite, bound params) + migração do file backend.
- `e2e/room.spec.ts` — rejoin hermético (sem sockets): 6 tokens sem dups.
- `e2e/lan.spec.ts` — loopback TCP real: host Node `net.Server` + guest `net.Socket`, snapshot + delta, versão stale rejeitada.
- CI: `cargo test` + `cargo build --features tauri-app` + `vitest` + `playwright` + release Win/Linux/Mac + APK Android.

### Fase 3 — App desktop jogável (em andamento)

Ver `docs/superpowers/plans/2026-10-11-vtt-app-fase3.md`. Tasks planejadas:

1. Editor de mapa UI no app (integrar `editor-panel` em `app.ts`) — **pendente**.
2. Ficha completa UI (painel editável, condições, habilidades) — **pendente**.
3. Three.js dado 3D (`three-view.ts`) — **pendente**.
4. Turno e iniciativa (`turn/turn-order.ts`) — **pendente**.
5. Interop Rust↔TS real (`src-tauri/src/bin/host.rs` + E2E com binário) — **pendente**.
6. mDNS + UDP cursor (`net/mdns.rs`, `net/udp.rs`) — **pendente**.

## Decisões arquiteturais

- **P2P estrela, host autoritativo**: o mestre é o host; todo estado crítico passa por ele. `placeTile` e `moveToken` retornam `ok: false` para roles não-host (fail-closed).
- **TCP estado / UDP cursor**: estado crítico (snapshot, tokens, tiles, rolls) via TCP ordenado; cursor e luz via UDP best-effort (ephemeral, loss-tolerant).
- **Sem servidor, sem conta**:发现 via mDNS (`_vtt._tcp`) ou IP:porta manual. Fallback offline: troca manual de código. Distribuição grátis via GitHub Releases.
- **RoomState particionado**: mapa chaveado por prefixo — `token:<id>`, `tile:<layer>:<x>,<y>`, `roll:<id>`, `sheet:<id>`. Deltas aplicam via `applyDelta` (remove-wins).
- **Save**: SQLite (rusqlite, bound params) como backend primário; file backend da Fase 1 mantido para migração. Export/import JSON para backup e sharing.
- **Assets por hash SHA-256**: endereçamento por conteúdo, cache local, `verify_asset` fail-closed (baixa de novo em caso de mismatch).
- **Sem arte WotC oficial**: sheets carregam stats apenas; campos de arte (`img`, `image`) são descartados no import SRD.
- **Feature flag `tauri-app`**: `crates.io` é inalcançável no sandbox local (HTTP 403); `cargo test` default não compila `tauri`; CI resolve e builda com rede.

## Dividas técnicas conhecidas

- **Turno v1**: `turn-order.ts` não existe ainda — planejado na Fase 3 Task 4. Não há sistema de turno no código atual.
- **Three.js stub**: `dice/scene.ts` é um stub puro (sem WebGL/DOM). Three.js real (`three-view.ts`) é Fase 3 Task 3.
- **Window nativa local**: o app Tauri compila no CI (com deps webkit via apt), mas não localmente (sem webkit/sudo). Verificação local usa `vitest` + `playwright smoke`.
- **Interop Rust↔TS real**: o bridge invoke atual usa `RoomStore` em memória por janela; o binário `host.rs` (Fase 3 Task 5) vai expor o socket real para o TS.
- **mDNS/UDP**: `MDNS_SERVICE` e `Channel::UdpCursor` definidos no protocolo, mas sem implementação de socket — Fase 3 Task 6.
- **Delta shape divergence**: o `Delta` Rust (`src-tauri/src/net/mod.rs`) exige `upsert`/`remove` como vecs obrigatórios; o TS (`src/net/peer.ts`) usa campos opcionais. O bridge FFI futuro deve adaptar entre os dois shapes.
- **Guest não tem estado**: após `join_room`, o guest não armazena estado no backend (`push_delta`/`get_snapshot` são host-only). Sync live de guest é escopo futuro.

## Como rodar

### Dev (browser offline)

```bash
npm install
npm run dev        # Vite em http://localhost:5199
```

### Testes

```bash
npm run test:unit          # vitest (TS)
npm run typecheck          # tsc --noEmit
npx playwright test e2e/  # room.spec + lan.spec (loopback TCP)
cd src-tauri && cargo test          # Rust (default features)
cd src-tauri && cargo build --features tauri-app  # build Tauri (requer rede + webkit)
```

### Build

```bash
npm run build      # vite build (frontend)
cd src-tauri && cargo build --features tauri-app  # Tauri app
```

CI (`.github/workflows/ci.yml`) roda release em tags `v*`: Win/Linux/Mac via `tauri-action`, APK Android via `@tauri-apps/cli android build --apk`.

## Referências

- Spec: `docs/superpowers/specs/2026-10-11-vtt-tauri-p2p-design.md`
- Plano Fase 1: `docs/superpowers/plans/2026-10-11-vtt-tauri-p2p.md`
- Plano Fase 2: `docs/superpowers/plans/2026-10-11-vtt-app-fase2.md`
- Plano Fase 3: `docs/superpowers/plans/2026-10-11-vtt-app-fase3.md`
- Arquitetura: `docs/architecture/README.md`
