# VTT Fase 3 — App Desktop Jogável Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar o shell fase 2 em app desktop jogável completo com editor de mapa, ficha completa, dado 3D, turno, e interop Rust↔TS real.

**Architecture:** Tauri 2 + frontend TS (Vite). Rust TCP/UDP + mDNS. Host autoritativo. Canvas 2D para mapa, Three.js para dado. Estado via RoomState partitions (token:, tile:, roll:, sheet:).

**Tech Stack:** Tauri 2, Rust (tokio, serde), Vite + TypeScript, Canvas 2D, Three.js, Vitest, Playwright, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-11-vtt-tauri-p2p-design.md`

## Global Constraints

- Alvos: Windows, Linux, Mac, Android APK. iOS fora.
- Distribuição grátis via GitHub Releases. Sem servidor central.
- Host autoritativo é o mestre. Só mestre escreve mapa.
- Import SRD 5.1 via Open5e / 5e SRD API. Sem arte oficial WotC.
- Estado crítico via TCP ordenado. Cursor e luz via UDP.
- Commits pequenos por task, em português ou inglês curto.
- Verificação local: cargo test + npx vitest run + Playwright smoke (sem webkit/sudo).

## Review Focus

- Editor: placeTile fail-closed não-host; tiles persistem no estado e renderizam.
- Ficha: decodeSheet valida abilities; condições não quebram applyDelta.
- Dado 3D: three.js só renderiza resultado; resolveRoll continua autoritativo.
- Turno: só host avança; jogador pede via delta; rejeição fora de turno legível.
- Interop: bridge invoke TS↔Rust funciona com binário real (não Node host).
- mDNS: descoberta não quebra join manual; UDP cursor é best-effort.

---

### Task 1: Editor de mapa UI no app

**Files:**
- Modify: `src/app.ts`
- Create: `src/ui/editor-panel.ts`
- Test: `src/ui/editor-panel.test.ts`

**Interfaces:**
- Consumes: `placeTile` de `src/map/editor.ts`, `createMap`, `tileKey`.
- Produces: `renderEditorPanel(container, map, onPlace)` para o app; usa `placeTile` real.

- [ ] **Step 1: Write the failing test**

```ts
test("editor panel places tile on host", () => {
  const map = createMap(10, 8);
  let placed: Tile | null = null;
  const el = document.createElement("div");
  renderEditorPanel(el, map, (t) => { placed = t; });
  const btn = el.querySelector("button")!;
  btn.click();
  expect(placed).not.toBeNull();
  expect(placed!.layer).toBe("floor");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/editor-panel.test.ts`
Expected: FAIL, `renderEditorPanel not found`.

- [ ] **Step 3: Implement `renderEditorPanel` em `src/ui/editor-panel.ts` e integre em `src/app.ts`**

Painel com: seletor de camada (floor/wall/asset), botão "Colocar tile" que chama `placeTile(map, tile, "host")` e dispara callback. Mostra grid atual (tiles existentes).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/editor-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/editor-panel.ts src/ui/editor-panel.test.ts src/app.ts
git commit -m "feat: map editor panel in app"
```

### Task 2: Ficha completa UI

**Files:**
- Modify: `src/app.ts`
- Modify: `src/sheet/types.ts`
- Create: `src/ui/sheet-panel.ts`
- Test: `src/ui/sheet-panel.test.ts`

**Interfaces:**
- Consumes: `Sheet` de `sheet/types`, `encodeSheet`/`decodeSheet` de `sheet/srd`.
- Produces: `renderSheetPanel(container, sheet, onUpdate)`; `Sheet` estendido com condições.

- [ ] **Step 1: Write the failing test**

```ts
test("sheet panel renders abilities and conditions", () => {
  const sheet: Sheet = { id: "p2", name: "Guerreiro", ac: 15, hp: 20, maxHp: 20, abilities: { str: 16, dex: 12, con: 14, int: 10, wis: 13, cha: 8 } };
  const el = document.createElement("div");
  renderSheetPanel(el, sheet, () => {});
  expect(el.textContent).toContain("For 16");
  expect(el.textContent).toContain("Condições");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/sheet-panel.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `renderSheetPanel` e estenda `Sheet` com `conditions?: string[]`**

Painel editável: inputs para AC/HP/atributos, lista de condições. Usa `encodeSheet`/`decodeSheet` para serialização. Valida abilities numéricas.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/sheet-panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ui/sheet-panel.ts src/ui/sheet-panel.test.ts src/sheet/types.ts src/app.ts
git commit -m "feat: full sheet panel with abilities and conditions"
```

### Task 3: Three.js dado 3D

**Files:**
- Modify: `src/app.ts`
- Create: `src/dice/three-view.ts`
- Test: `src/dice/three-view.test.ts`

**Interfaces:**
- Consumes: `frameForResult` de `dice/scene`, `RollResult`.
- Produces: `createThreeDiceView(container)` com `show(result)`.

- [ ] **Step 1: Write the failing test**

```ts
test("three view shows resolved faces", () => {
  const el = document.createElement("div");
  const view = createThreeDiceView(el);
  view.show({ sides: 20, count: 1, mod: 0, rolls: [15], total: 15 });
  expect(el.querySelector("canvas")).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dice/three-view.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `createThreeDiceView` com Three.js**

Cena Three.js: Mesh de dado (BoxGeometry ou DodecahedronGeometry), material com número da face. `show(result)` anima para a face resolvida. `npm install three @types/three`. Stub se WebGL indisponível (test env).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dice/three-view.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dice/three-view.ts src/dice/three-view.test.ts src/app.ts package.json
git commit -m "feat: three.js dice 3d view"
```

### Task 4: Turno e iniciativa

**Files:**
- Create: `src/turn/turn-order.ts`
- Test: `src/turn/turn-order.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: `applyDelta` de `net/peer`, `tokenKey`.
- Produces: `createTurnOrder(memberIds)`, `advanceTurn(order)`, `requestTurn(order, tokenId)`.

- [ ] **Step 1: Write the failing test**

```ts
test("only host advances turn", () => {
  const order = createTurnOrder(["dm", "p1", "p2"]);
  order.advanceTurn("host");
  expect(order.current).toBe("p1");
  order.advanceTurn("player");
  expect(order.current).toBe("p1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/turn/turn-order.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement turn order com fail-closed**

`createTurnOrder(memberIds)` cria ordem por iniciativa (default: ordem array). `advanceTurn(role)` só host avança. `requestTurn(tokenId)` retorna delta `turn:current` para broadcast. Sheet `turn:<token>` partition.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/turn/turn-order.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/turn/turn-order.ts src/turn/turn-order.test.ts src/app.ts
git commit -m "feat: turn order and initiative"
```

### Task 5: Interop Rust↔TS real (binário host)

**Files:**
- Create: `src-tauri/src/bin/host.rs`
- Test: `e2e/rust-bridge.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `serve_once`/`connect_handshake` de `net/tcp`, `commands`.
- Produces: binário `host` que serve TCP real; E2E com binário + browser.

- [ ] **Step 1: Write the failing test**

```ts
test("real rust host serves snapshot to browser guest", async () => {
  const bin = await buildHostBinary();
  const host = spawn(bin, ["--port", "7001"]);
  await sleep(500);
  const guest = await joinVia("127.0.0.1:7001", invokeViaBridge);
  expect(guest.room).toMatch(/^room-/);
  host.kill();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/rust-bridge.spec.ts`
Expected: FAIL, binário não existe.

- [ ] **Step 3: Implement binário `src-tauri/src/bin/host.rs`**

Arg `--port N`, chama `serve_once` loop, `create_room` state, responde handshake. CI job compila binário e roda E2E.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo build --bin host && npx playwright test e2e/rust-bridge.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/host.rs e2e/rust-bridge.spec.ts .github/workflows/ci.yml
git commit -m "feat: real rust host binary with e2e bridge test"
```

### Task 6: mDNS + UDP cursor

**Files:**
- Create: `src-tauri/src/net/mdns.rs`
- Create: `src-tauri/src/net/udp.rs`
- Test: `src-tauri/tests/mdns_test.rs`, `src-tauri/tests/udp_test.rs`

**Interfaces:**
- Consumes: `MDNS_SERVICE` de `net/proto`.
- Produces: `announce(port)`, `discover() -> Vec<RoomInfo>`, `send_cursor(pos, room)`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn mdns_announce_discovers() {
    let handle = announce(7001).unwrap();
    let found = discover().unwrap();
    assert!(found.iter().any(|r| r.port == 7001));
    drop(handle);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test mdns_test`
Expected: FAIL.

- [ ] **Step 3: Implement mDNS announce/discover + UDP cursor**

mDNS via `mdns-sd` crate (ou manual UDP multicast). UDP cursor: `send_cursor` best-effort, sem retransmissão.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test --test mdns_test --test udp_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/net/mdns.rs src-tauri/src/net/udp.rs src-tauri/tests/mdns_test.rs src-tauri/tests/udp_test.rs src-tauri/Cargo.toml
git commit -m "feat: mdns discovery and udp cursor"
```
