# VTT Fase 2 — App Jogável Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mesa jogável: browser via Vite (sala, mapa, tokens, dados) + bootstrap Tauri 2 real compilando no CI + sockets TCP reais com handshake.

**Architecture:** Frontend Vite+TS como shell jogável (usa `src/net`, `src/map`, `src/sheet`, `src/dice` prontos). Rust vira `lib.rs` (lógica) + `main.rs` (bin Tauri); comandos `invoke` expõem sala/rede; tokio serve TCP real em loopback/LAN. Janela nativa validada no CI (webkit via apt), não local.

**Tech Stack:** Tauri 2 (latest 2.x na execução), tokio + tauri-plugin-sql/rusqlite, Vite 5+, TypeScript, Canvas 2D, Vitest, Playwright, cargo test.

**Spec:** `docs/superpowers/specs/2026-10-11-vtt-tauri-p2p-design.md` (base) + este plano (fase 2).

## Global Constraints

- Alvos: Windows, Linux, Mac, Android APK. iOS fora.
- Distribuição grátis via GitHub Releases. Sem servidor central.
- Host autoritativo é o mestre. Só mestre escreve mapa (moveToken com role, já no branch).
- Import SRD 5.1 via Open5e / 5e SRD API. Sem arte oficial WotC.
- Estado crítico via TCP ordenado. Cursor e luz via UDP.
- Janela Tauri não compila sem webkit: validar no CI, nunca exigir build local.
- Commits pequenos por task, em português ou inglês curto.

## Review Focus

- `npm run dev` abre sala jogável offline (2 clientes na mesma página ou 2 abas sincronizadas via estado local).
- `tauri dev/build` passa no CI Linux com deps apt; nenhum `unwrap`/`expect` em caminho de rede.
- Host real aceita conexão TCP loopback, handshake rejeita versão errada no fio, snapshot chega sem duplicar token.
- Save rusqlite abre arquivo da fase 1 (file backend) ou migra com erro legível.
- Erro de conexão mostra IP:porta + hint ZeroTier/Radmin/Hamachi (strings já existem, manter).

---

### Task 1: Shell Vite jogável offline

**Files:**
- Create: `index.html`
- Create: `vite.config.ts`
- Create: `src/app.ts`
- Create: `src/ui/room.ts`
- Create: `src/ui/mapview.ts`
- Test: `src/ui/room.test.ts`

**Interfaces:**
- Consumes: `peer.ts` (createRoom/joinRoom/applyDelta), `map/*`, `sheet/*`, `dice/*` (prontos, sem mudar).
- Produces: `startApp(root: HTMLElement)` usado pela Task 4 (bootstrap injeta no webview).

- [ ] **Step 1: Write the failing test**

```ts
test("offline room hosts 6 tokens", () => {
  const room = createOfflineRoom(["dm","p1","p2","p3","p4","p5"]);
  expect(room.tokenCount()).toBe(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/room.test.ts`
Expected: FAIL, `createOfflineRoom not found`.

- [ ] **Step 3: Implement shell offline em `src/ui/` + `index.html` + `vite.config.ts`**

Sala local (host simulado) + canvas com grid/fog/luz/tokens + painel ficha + dado. Sem rede.

- [ ] **Step 4: Run tests + dev smoke**

Run: `npx vitest run src/ui && npm run dev -- --port 5199 & sleep 3; curl -s -o /dev/null -w "%{http_code}" http://localhost:5199; kill %1`
Expected: PASS, `200`.

- [ ] **Step 5: Commit**

```bash
git add index.html vite.config.ts src/ui src/app.ts
git commit -m "feat: offline playable vite shell"
```

### Task 2: Bootstrap Tauri 2 real (compila no CI)

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/main.rs`
- Create: `src-tauri/capabilities/default.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: módulos `net`, `assets`, `save` (mover de `main.rs` para `lib.rs`, manter shims de teste).
- Produces: `tauri::Builder` com invoke handler usado na Task 4.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn lib_exposes_net_and_save() {
    assert!(vtt_tauri::net::PROTOCOL_VERSION_MAJOR >= 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p vtt-tauri --test health_test`
Expected: FAIL (sem lib ainda).

- [ ] **Step 3: Implement `lib.rs` + deps tauri 2 + capabilities + CI com deps apt**

Confirmar latest Tauri 2.x na execução. CI instala `libwebkit2gtk-4.1-dev` etc. e roda `cargo build`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p vtt-tauri`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri .github/workflows/ci.yml
git commit -m "feat: real tauri 2 bootstrap with lib"
```

### Task 3: TCP real + handshake no fio

**Files:**
- Create: `src-tauri/src/net/tcp.rs`
- Test: `src-tauri/tests/tcp_test.rs`

**Interfaces:**
- Consumes: `handshake`, `encode/decode_handshake`, `RoomInfo` da fase 1.
- Produces: `serve_once(listener) -> Handshake`, `connect_handshake(addr) -> RoomInfo` para Task 4.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn loopback_rejects_version_mismatch() {
    let res = roundtrip_handshake("0.9");
    assert!(res.is_err());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test tcp_test`
Expected: FAIL, `roundtrip_handshake not found`.

- [ ] **Step 3: Implement listener tokio + handshake length-prefixed em `tcp.rs`**

Bind `127.0.0.1:0` (porta efêmera) nos testes. Sem `.expect` em caminho de rede.

- [ ] **Step 4: Run tests**

Run: `cargo test --test tcp_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/net/tcp.rs src-tauri/tests/tcp_test.rs
git commit -m "feat: real tcp handshake loopback"
```

### Task 4: Bridge invoke + fiação sala real

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src/app.ts`
- Test: `src/ui/room.test.ts` (estender: join via invoke mockado)

**Interfaces:**
- Consumes: `startApp` (T1), invoke handler (T2), `serve/connect_handshake` (T3).
- Produces: app completo: host real + join real via janela Tauri; browser segue offline.

- [ ] **Step 1: Write the failing test**

```ts
test("join failure surfaces ip and vpn hint", async () => {
  await expect(joinVia("999.999.1.1:7000", failingInvoke)).rejects.toThrow(/ZeroTier/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/room.test.ts`
Expected: FAIL, `joinVia not found`.

- [ ] **Step 3: Implement `commands.rs` (create_room, join_room, push_delta, get_snapshot) + fiação `app.ts`**

Frontend detecta `window.__TAURI__`: com Tauri usa invoke, sem usa offline.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/ui && cargo test -p vtt-tauri`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src/app.ts src/ui
git commit -m "feat: tauri invoke bridge with real room"
```

### Task 5: rusqlite no save + migração do file backend

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/save.rs`
- Test: `src-tauri/tests/save_sqlite_test.rs`

**Interfaces:**
- Consumes: `save.rs` fase 1 (formato file + SCHEMA_SQL + helpers).
- Produces: backend SQLite com bind params, golden intacto.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn sqlite_roundtrip_six_tokens() {
    let db = open_memory();
    assert_eq!(restore_all(&db).unwrap().len(), 6);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --test save_sqlite_test`
Expected: FAIL, `open_memory not found`.

- [ ] **Step 3: Implement backend rusqlite com bind params + migração do file**

Arquivo fase 1 abre ou retorna erro legível de migração. `sql_quote` vira doc-only com aviso DO NOT EXECUTE.

- [ ] **Step 4: Run tests (incl. golden antigo)**

Run: `cargo test -p vtt-tauri`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat: sqlite backend with migration"
```

### Task 6: E2E rede real loopback + release check

**Files:**
- Create: `e2e/lan.spec.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: todas as tasks desta fase.
- Produces: CI verde com E2E de rede + build desktop/APK por tag.

- [ ] **Step 1: Write the failing test**

```ts
test("loopback host serves snapshot to guest", async () => {
  await expect(guest.tokenCount()).toBe(6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test e2e/lan.spec.ts`
Expected: FAIL, sem harness de rede.

- [ ] **Step 3: Implement harness loopback (host real + guest via invoke mockado ou binário) e job release**

Harness sobe listener `127.0.0.1:0`, guest conecta, valida 6 tokens sem dups.

- [ ] **Step 4: Run E2E**

Run: `npx playwright test e2e/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add e2e .github/workflows/ci.yml
git commit -m "feat: loopback network e2e and release"
```
