# VTT All-Phases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar Fase 3 e evoluir o VTT para paridade Roll20/Foundry em P2P self-hosted.

**Architecture:** Host autoritativo em estrela (Tauri+Rust), RoomState particionado `<prefix>:<id>` com applyDelta remove-wins, TCP para estado, UDP para ephemeral. Puro/hermético primeiro, UI depois, Tauri por último.

**Tech Stack:** Tauri 2 + Rust (tokio) + Vite/TS + Canvas 2D + Three.js + vitest/jsdom + Playwright.

**Spec:** `/home/x/Downloads/Handoff — VTT P2P self-hosted.md` (autoridade; este plano é o argumento). Branch base: `6a470eb` (main).

## Global Constraints

- Host autoritativo, fail-closed: validar role ANTES de emitir delta E revalidar no apply.
- Partições `<prefix>:<id>`, remove-wins; composto consistente viaja como UM JSON atômico.
- Estado crítico TCP ordenado; ephemeral (cursor/luz) UDP best-effort.
- Filtrar na INGESTÃO, não só no render (precedente: gmNotes).
- Puro/hermético primeiro, UI depois, Tauri por último; cada módulo com `.test.ts`; UI com jsdom + `data-testid`.
- UI em pt-BR; commits pequenos em inglês; sem arte WotC (só SRD CC-BY/procedural/SVG); iOS fora.
- Delta TS/Rust: mexer em ambos = atualizar `golden_test.rs` + `peer.test.ts` juntos.
- Sem cargo/webkit no dev box: código Rust validado via CI (`.github/workflows/ci.yml`); implementador TS roda `npx vitest run` + `npm run typecheck`.
- Suite atual: 38 arquivos, 258 testes verdes — não regredir.

## Review Focus

- Guest recebendo dado que não deveria ver (gmNotes, FoW, fichas alheias) via fallback verbatim ou projeção esquecida.
- Player emitindo delta que o host aplica sem revalidar role/ACL.
- Delta shape Rust (vecs obrigatórios) vs TS (opcionais) divergindo no wire.
- Grid/tiles/fog dessincronizados entre editor e mesa (instâncias de room diferentes).
- localStorage usado como fonte de verdade em vez de cache do RoomState.

---

### Task 0: Fase 0 — Plugar mapa e fichas na mesa

**Files:**
- Modify: `src/ui/table-tools.ts`, `src/ui/app-shell.ts`, `src/app.ts`, `src/ui/table-view.ts`, `src/ui/token-bar.ts`
- Create: `src/map/resize.ts` (helper `resizeGrid`), `e2e/map-sheets.spec.ts`
- Consume (órfãos a plugar, NÃO reescrever): `src/ui/map-editor.ts`, `src/ui/editor-panel.ts`, `src/map/layers.ts`, `src/map/grid.ts`, `src/map/grid-config.ts`, `src/sheet/srd.ts`, `src/ui/sheet-creator.ts`, `src/ui/character-library.ts`

**Interfaces:**
- Consumes: `renderMapEditor({ room, role, onStatus })`, `MAP_INFO_KEY`/`mapFromState`/`decodeMapInfo`/`visibleTiles(state, role)` de `map/layers.ts`, `createGrid(w,h)`, `loadGridConfig/saveGridConfig`, `canControl(sheet, peerId, isGM)` + `sanitizeSheetWrite` de `sheet/acl.ts`, `fetchSrd`/`importMonster` de `sheet/srd.ts`, `createSheetCreator` de `sheet-creator.ts`.
- Produces: mesa monta editor (GM), grid deriva de `map:info`, tiles renderizam por role, `grid:main` no RoomState, push de ficha por ACL (não só GM), criar ficha + biblioteca + import SRD dentro da mesa, "Levar para a mesa".

- [ ] **Step 1: Escrever testes failing** — `resizeGrid` preserva células (grid.test ou novo `resize.test.ts`); gate de push: controller não-GM consegue push da própria ficha; editor monta com o MESMO room da sessão.
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run <arquivos>` → FAIL.
- [ ] **Step 3: Implementar itens 1–8 da Fase 0 do handoff** (mapa itens 1–4, fichas itens 5–8; item 8 vira teste se save.rs já persiste `sheet:*`).
- [ ] **Step 4: E2E `e2e/map-sheets.spec.ts`** conforme gate da Fase 0 (vale caminho OfflineRoom + pull de snapshot do host binário).
- [ ] **Step 5: Suite verde** — `npx vitest run` + `npm run typecheck`, sem regressão.
- [ ] **Step 6: Commit** — `git add` só arquivos do escopo; mensagem curta em inglês.

### Task 1: Fase A — Transporte multi-peer real

**Files:**
- Create: `src-tauri/src/net/server.rs`, `e2e/multi-peer.spec.ts`
- Modify: `src-tauri/src/net/mod.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src/ui/app-shell.ts` (Backend ganha `onEvent(cb)`), `src-tauri/tests/golden_test.rs`, `src/net/peer.test.ts`

**Interfaces:**
- Consumes: `RoomStore`, `decode_handshake`, framing de `tcp.rs`, `Emitter` do Tauri, `Backend` de `app-shell.ts`.
- Produces: `serve_room(port, store)` (accept loop, roster, validação role, broadcast), comandos `host_start`/`host_stop`/`connect_peer`, evento `room-event`, resume token por peerId, golden round-trip `{}` vazio/parciais TS↔Rust.

- [ ] **Step 1: Testes failing** — golden `{}`/parciais nos dois lados; fan-out: delta de A chega em B (vale teste Rust-only + E2E Node até CI validar).
- [ ] **Step 2: Rodar TS e ver falhar** (`npx vitest run`); Rust valida no CI.
- [ ] **Step 3: Implementar itens 1–5 da Fase A** (server.rs, comandos, reconexão, golden, E2E multi-peer).
- [ ] **Step 4: Suite TS verde + typecheck**; push para CI validar `cargo test`.
- [ ] **Step 5: Commit** escopado, inglês.

### Task 2: Fase B — Visão por jogador (FoW + luz per-peer)

**Files:**
- Create: `src/map/fow.ts`, `src/map/fow.test.ts`
- Modify: `src/map/fog.ts`, `src/map/light.ts`, `src/ui/table-view.ts`

**Interfaces:**
- Consumes: `revealFog`, `computeLight`, `hasLineOfSight`, `encodeDelta`, `visibleSheets` (padrão de filtro na ingestão).
- Produces: partição `fow:<tokenId-ou-peerId>` (explored sticky serializada), `visibleFor(peerTokens, lightSources, walls)` (bright/dim), `LightSource { type, animating, color }`, render por role (GM overlay / player máscara local), auto-reveal opcional, máscara default p/ novos players.

- [ ] **Step 1: Testes failing** — sticky, re-fog GM, isolamento per-peer, player novo não vê token de monstro em área não-explored.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar itens da Fase B** (host nunca envia máscara global crua; filtro na ingestão).
- [ ] **Step 4: Suite verde + typecheck.**
- [ ] **Step 5: Commit.**

### Task 3: Fase C — Turno/combate na UI

**Files:**
- Create: `src/ui/turn-panel.ts` (+ teste)
- Modify: `src/ui/app-shell.ts`, `src/ui/table-view.ts` (anel no ativo), `src/ui/chat.ts` (anúncio `turn:<nome>`)

**Interfaces:**
- Consumes: `startCombat/advanceTurn/endCombat/readTurn/activeCombatant` de `turn/turn.ts`, `resolveRoll`, `conditions` de `sheet/types.ts`.
- Produces: barra de iniciativa, rolar-iniciativa (host), próximo turno (host), fim de combate, bloqueio de movimento fora de turno (shell checa + host revalida), condições como chips clicáveis.

- [ ] **Step 1: Testes failing** — painel renderiza ordem; não-ativo não move (fail-closed); host revalida.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar itens 1–3 da Fase C.**
- [ ] **Step 4: Suite verde + typecheck.**
- [ ] **Step 5: Commit.**

### Task 4: Fase D — Lighting avançada + line-of-sight

**Files:**
- Modify: `src/map/light.ts`, `src/map/fog.ts`, `src/ui/table-view.ts`
- Create: testes em `src/map/light.test.ts` (ou novo)

**Interfaces:**
- Consumes: `hasLineOfSight`, máscaras da Fase B.
- Produces: walls como bitmask por aresta de célula (portas `door:<id>` abrem/fecham raycast), LOS compartilhado com FoW, gradiente radial por fonte no canvas, toggle GM "iluminação ambiente global".

- [ ] **Step 1: Testes failing** — porta fechada bloqueia, aberta passa; diagonal; ambiente global.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar itens da Fase D** (compatível com grid quadrado/hex).
- [ ] **Step 4: Suite verde + typecheck.**
- [ ] **Step 5: Commit.**

### Task 5: Fase E — Assets, áudio e mídia

**Files:**
- Create: `src/ui/asset-drop.ts` (+ teste), `src/journal/journal.ts` (+ teste), painel journal
- Modify: `src-tauri/src/net/tcp.rs` (frame `asset:get/<hash>`), `src/ui/table-view.ts`, `src/map/tokens.ts` (`sheetId`, avatar da `photo`)

**Interfaces:**
- Consumes: SHA-256 cache (`assets.rs` + TS), delta `media:now`, `viewers/controllers` de `acl.ts`, `hp/maxHp` via `visibleSheets`.
- Produces: drag-and-drop imagem/áudio no mapa (host serve bytes por hash), playlist ambience sincronizada (botão "sincronizar" no player), `journal:<id>` com ACL, handout→tile, token com avatar/tintura/barra HP vinculada à ficha.

- [ ] **Step 1: Testes failing** — journal ACL, token bar reflete HP, `media:now` aplica offset.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar itens 1–4 da Fase E** (Rust valida no CI).
- [ ] **Step 4: Suite TS verde + typecheck.**
- [ ] **Step 5: Commit.**

### Task 6: Fase F — Segurança & lobby P2P WAN

**Files:**
- Modify: `src-tauri/src/net/` (handshake: nonce + HMAC com secret do invite, rejeição replay), `src/session/peers.ts`, menu (botão "salas próximas" via `discover()`)
- Avaliar: iroh (QUIC/hole-punching) — se inviável offline nesta sessão, implementar HMAC+replay+TLS-ready e deixar iroh como follow-up documentado.

**Interfaces:**
- Consumes: `createSecret`/`rotateSecret`, `secret` do invite, `discover()` de `mdns.rs`.
- Produces: handshake autenticado (HMAC, anti-replay), comando Tauri p/ discover exposto no menu, decisão iroh documentada.

- [ ] **Step 1: Testes failing** — replay rejeitado, HMAC errado rejeitado, secret antigo inválido após rotate.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar itens da Fase F.**
- [ ] **Step 4: Suite verde + typecheck.**
- [ ] **Step 5: Commit.**

### Task 7: Fase G — QoL Roll20-parity

**Files:**
- Modify: ficha UI (macros a partir de `actions`, 1-clique saves/perícias, death saves), chat (stealth rolls), `rooms` settings (`settings:<key>`), multi-cena (`scene:<id>` + `map:scenes`)

**Interfaces:**
- Consumes: `actions`/`deathSaves`/currency de `types.ts`, `createSecret`/`rotateSecret` (hotseat futuro), tabela `rooms` do SQLite.
- Produces: ability buttons → `!roll` no chat, death saves UI, stealth roll GM-only, settings por mesa, troca de cena ativa com broadcast.

- [ ] **Step 1: Testes failing** por item.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar itens da Fase G.**
- [ ] **Step 4: Suite verde + typecheck.**
- [ ] **Step 5: Commit.**

### Task 8: Fase H — Conteúdo embutido (H2 → H1 → H3) + H0/H4 triagem

**Files:**
- Create: `src/map/packs.ts`, `src/ui/map-wizard.ts`, `src/ui/token-config.ts`, `src/compendium/{types,store,ui}.ts`, testes (`packs.test.ts`, `dungeon.test.ts` seed fixa, `compendium-store.test.ts`), `e2e/content.spec.ts`
- Modify: `src/map/tokens.ts` (`size`, `tint`, `nameVisible`, `bar`, `avatarAsset?`, `sheetId?`), `src-tauri/src/save.rs` (tabela `compendium`)

**Interfaces:**
- Consumes: pipeline Fase 0 (map:info + tiles), `importMonster`, `visibleSheets`, `map:scenes`.
- Produces: pack builtin ~10 cenários táticos (JSON descritivo, sem binaries), wizard "Novo mapa" (template|branco|procedural), `generateDungeon(rng, {rooms, seed})` determinístico, catálogo SVG inline de avatares, painel token-config, packs SRD-CC estáticos (monstros/itens/spells), export/import `.json`, painel Compendium (busca, stat block, importar p/ mesa), H0: marcar itens fechados por fase, resto → H4 backlog ou "fora de escopo v1".

- [ ] **Step 1: Testes failing** — dungeon seed fixa determinística, store versionado, wizard cria cena.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar H2 → H1 → H3.**
- [ ] **Step 4: E2E `e2e/content.spec.ts`** conforme gate da Fase H.
- [ ] **Step 5: Suite verde + typecheck.**
- [ ] **Step 6: Commit(s).**
