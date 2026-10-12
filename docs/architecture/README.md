# VTT Architecture

## Visão geral

App Tauri 2 + Vite + TypeScript para mesa de D&D 5e P2P (mestre + 5 jogadores). Um código só para Windows, Linux, Mac e Android APK. Sem servidor central — hospedagem via IP:porta ou mDNS.

## Topologia

**P2P estrela com host autoritativo.** O mestre é o host; todo estado crítico passa por ele. Peers conectam via TCP (estado ordenado) e UDP (cursor/luz best-effort). O host envia snapshot cheio no join e depois apenas deltas.

## Módulos

| Módulo | Arquivos | Descrição |
|--------|----------|-----------|
| **Network** | `src/net/peer.ts`, `src-tauri/src/net/` | Handshake JSON, `applyDelta`, TCP length-prefixed, snapshot/delta |
| **Map** | `src/map/`, `src/ui/mapview.ts`, `src/ui/editor-panel.ts` | Grid, fog, luz, tokens, editor de tiles, assets por hash |
| **Sheet** | `src/sheet/` | Ficha D&D, import SRD (Open5e), serialização RoomState |
| **Dice** | `src/dice/` | `resolveRoll` host-autoritativo, publishRoll, cena stub |
| **Persistence** | `src-tauri/src/save.rs` | SQLite (rusqlite) + file backend Fase 1 + export/import JSON |
| **App Shell** | `src/app.ts`, `src/ui/room.ts` | startApp, menu, ponte Tauri invoke, OfflineRoom |
| **E2E** | `e2e/` | Testes protocol-conformance (loopback TCP) e rejoin |

## Decisões-chave

- **TCP estado / UDP cursor**: estado crítico (snapshot, tokens, tiles, rolls) via TCP ordenado; cursor e luz via UDP best-effort.
- **RoomState particionado**: `token:<id>`, `tile:<layer>:<x>,<y>`, `roll:<id>`, `sheet:<id>`. Deltas aplicam via `applyDelta` (remove-wins).
- **Host autoritativo fail-closed**: `placeTile` e `moveToken` retornam `ok: false` para roles não-host.
- **Assets por hash SHA-256**: endereçamento por conteúdo, cache local, verificação fail-closed.
- **Sem arte WotC**: sheets carregam stats apenas; campos de arte descartados no import SRD.

## Dividas técnicas

- Turno v1 (Fase 3 Task 4), Three.js stub (Fase 3 Task 3), window nativa local não compila, interop Rust↔TS real via binário (Fase 3 Task 5), mDNS/UDP (Fase 3 Task 6).
- `Delta` Rust exige vecs obrigatórios; TS usa campos opcionais. Bridge FFI deve adaptar.

## Referências

- Spec: `docs/superpowers/specs/2026-10-11-vtt-tauri-p2p-design.md`
- Planos: `docs/superpowers/plans/` (Fase 1, 2, 3)
