# VTT Tauri P2P Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App Tauri com mesa D&D 5e P2P para mestre + 5 via IP direto.

**Architecture:** Tauri 2 + frontend TS. Rust abre TCP/UDP e mDNS. Mestre é host autoritativo em estrela. Snapshot cheio, depois deltas.

**Tech Stack:** Tauri 2, Rust (tokio, serde), Vite + TypeScript, Canvas 2D, Three.js, SQLite (tauri-plugin-sql), Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-11-vtt-tauri-p2p-design.md`

## Global Constraints

- Alvos: Windows, Linux, Mac, Android APK. iOS fora.
- Distribuição grátis via GitHub Releases. Sem servidor central.
- Host autoritativo é o mestre. Só mestre escreve mapa.
- Import SRD 5.1 via Open5e / 5e SRD API. Sem arte oficial WotC.
- Estado crítico via TCP ordenado. Cursor e luz via UDP.
- Commits pequenos por task, em português ou inglês curto.

## Review Focus

- IP inválido ou porta fechada mostra IP do host e sugere ZeroTier, sem travar.
- Versão de protocolo diferente rejeita com mensagem legível.
- Asset com hash errado baixa de novo em vez de quebrar mapa.
- Cliente que cai reconecta e recebe snapshot sem duplicar token.
- Rolagem fora de turno ou com dados inválidos é rejeitada pelo host.

---

### Task 1: Scaffold Tauri + CI

**Files:**
- Create: `src-tauri/Cargo.toml`
- Create: `src-tauri/tauri.conf.json`
- Create: `src-tauri/src/main.rs`
- Create: `src/main.ts`
- Create: `.github/workflows/ci.yml`
- Test: `src-tauri/tests/health_test.rs`

**Interfaces:**
- Consumes: nada.
- Produces: `app_health() -> { ok: true }` usado como base das tasks seguintes.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn app_boots_with_health_ok() {
    assert_eq!(app_health(), true);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p vtt-tauri --test health_test`
Expected: FAIL, `app_health not found`.

- [ ] **Step 3: Implement `app_health() -> bool` em `src-tauri/src/main.rs`**

Retorna `true`. Cria scaffold Tauri mínimo + `src/main.ts` com tela de sala (host/entrar).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p vtt-tauri --test health_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri src .github/workflows/ci.yml
git commit -m "feat: scaffold tauri with health test"
```

### Task 2: Rede P2P e protocolo

**Files:**
- Create: `src-tauri/src/net/mod.rs`
- Create: `src-tauri/src/net/proto.rs`
- Create: `src/net/peer.ts`
- Test: `src-tauri/tests/net_test.rs`
- Test: `src/net/peer.test.ts`

**Interfaces:**
- Consumes: scaffold da Task 1.
- Produces: `create_room(port: u16) -> RoomInfo`, `join_room(ip: string, port: u16) -> Peer`, `apply_delta(state, delta) -> state` para Tasks 3-6.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn handshake_rejects_version_mismatch() {
    let res = handshake("0.9", "1.0");
    assert!(res.is_err());
}
```

```ts
test("rejects bad ip", () => {
  expect(() => parseRoomAddr("999.999.1.1:7000")).toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --test net_test`
Expected: FAIL, `handshake not found`.
Run: `npx vitest run src/net/peer.test.ts`
Expected: FAIL, `parseRoomAddr not found`.

- [ ] **Step 3: Implement `handshake`, `parseRoomAddr`, `create_room`, `join_room`**

Protocolo JSON com `version`, `room`, `role`. TCP para estado, UDP para cursor. mDNS anuncia `_vtt._tcp`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --test net_test`
Expected: PASS.
Run: `npx vitest run src/net/peer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/net src/net
git commit -m "feat: p2p room protocol with handshake"
```

### Task 3: Mapa, fog, luz e tokens

**Files:**
- Create: `src/map/grid.ts`
- Create: `src/map/fog.ts`
- Create: `src/map/light.ts`
- Create: `src/map/tokens.ts`
- Test: `src/map/fog.test.ts`

**Interfaces:**
- Consumes: `apply_delta` da Task 2.
- Produces: `revealFog(fog, polygon) -> fog`, `computeLight(map, sources) -> mask`, `moveToken(state, id, pos) -> delta` para Tasks 4 e 6.

- [ ] **Step 1: Write the failing test**

```ts
test("reveal removes only polygon area", () => {
  expect(countVisible(revealFog(emptyFog(), polyA))).toBe(12);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/map/fog.test.ts`
Expected: FAIL, `revealFog not found`.

- [ ] **Step 3: Implement `revealFog`, `computeLight`, `moveToken` em `src/map/`**

Canvas + grid. Fog por máscara. Luz por raycasting simples. Token com id, pos, hp.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/map`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/map
git commit -m "feat: map fog light tokens"
```

### Task 4: Editor de mapa e assets

**Files:**
- Create: `src/map/editor.ts`
- Create: `src-tauri/src/assets.rs`
- Test: `src/map/editor.test.ts`
- Test: `src-tauri/tests/assets_test.rs`

**Interfaces:**
- Consumes: `moveToken`, snapshot da Task 3.
- Produces: `assetHash(bytes) -> hex`, `placeTile(map, tile, role) -> Result<delta>` para Task 7.

- [ ] **Step 1: Write the failing test**

```ts
test("only host delta writes tiles", () => {
  expect(placeTile(clientMap, tile, "player").ok).toBe(false);
});
```

```rust
#[test]
fn bad_hash_triggers_redownload() {
    assert!(verify_asset(&bytes, "deadbeef").is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/map/editor.test.ts`
Expected: FAIL.
Run: `cargo test --test assets_test`
Expected: FAIL.

- [ ] **Step 3: Implement `placeTile` e `assetHash`/`verify_asset`**

Editor com tiles e camadas. Asset por hash SHA-256 com cache local. Cliente sem papel host recebe `ok: false`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/map/editor.test.ts && cargo test --test assets_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/map/editor.ts src-tauri/src/assets.rs
git commit -m "feat: map editor and hashed assets"
```

### Task 5: Ficha D&D e import SRD

**Files:**
- Create: `src/sheet/types.ts`
- Create: `src/sheet/srd.ts`
- Test: `src/sheet/srd.test.ts`

**Interfaces:**
- Consumes: snapshot/delta da Task 2.
- Produces: `importMonster(entry) -> Sheet`, `rollRequest(dice) -> Roll` para Task 6.

- [ ] **Step 1: Write the failing test**

```ts
test("imports srd goblin with ac and hp", async () => {
  const s = importMonster(goblinSrd);
  expect(s.ac).toBe(15); expect(s.hp).toBe(7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sheet/srd.test.ts`
Expected: FAIL, `importMonster not found`.

- [ ] **Step 3: Implement `importMonster` e `fetchSrd` em `src/sheet/srd.ts`**

Mapeia JSON Open5e/5e-SRD para `Sheet`. Cache local. Sem arte WotC.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sheet`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sheet
git commit -m "feat: dnd sheet and srd import"
```

### Task 6: Dado 3D com resolução no host

**Files:**
- Create: `src/dice/roller.ts`
- Create: `src/dice/scene.ts`
- Test: `src/dice/roller.test.ts`

**Interfaces:**
- Consumes: `rollRequest` da Task 5, `apply_delta` da Task 2.
- Produces: `resolveRoll(req) -> RollResult` difundido a todos.

- [ ] **Step 1: Write the failing test**

```ts
test("host rejects d20 with 21 faces", () => {
  expect(() => resolveRoll({ sides: 21 })).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/dice/roller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `resolveRoll` em `src/dice/roller.ts` e cena em `scene.ts`**

Cliente pede, host valida e difunde. Three.js só renderiza resultado.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/dice`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dice
git commit -m "feat: host-resolved 3d dice"
```

### Task 7: Save, release e E2E

**Files:**
- Create: `src-tauri/src/save.rs`
- Create: `e2e/room.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: todas as tasks.
- Produces: release com instaladores + APK e teste E2E verde.

- [ ] **Step 1: Write the failing test**

```ts
test("rejoin gets snapshot without dup tokens", async () => {
  await expect(room.tokenCount()).toBe(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/room.spec.ts`
Expected: FAIL, sem app ou rota.

- [ ] **Step 3: Implement `save/load` SQLite + export JSON e CI de release**

CI gera Win/Linux/Mac + APK. Save local com export JSON.

- [ ] **Step 4: Run E2E LAN com 2 peers**

Run: `npx playwright test e2e/room.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/save.rs e2e .github/workflows/ci.yml
git commit -m "feat: save release e2e"
```
