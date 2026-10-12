# App Shell

## Responsabilidades

Bootstrap do app jogável: menu inicial (Hospedar/Entrar/Criar Ficha), ponte Tauri invoke, OfflineRoom (host simulado local), canvas mapa, painel ficha e painel dado.

## Arquivos

- `src/main.ts` — entry Vite (placeholder, chama `renderRoomScreen`).
- `src/app.ts` — `startApp(root: HTMLElement)`: menu + app completo.
- `src/ui/room.ts` — `OfflineRoom`, `createOfflineRoom`, `joinVia`, `replaceDelta`, `guestJoinNotice`, `InvokeFn`.
- `src/ui/mapview.ts` — `renderMapView` (canvas 2D).
- `src/ui/editor-panel.ts` — `renderEditorPanel` (não wireado ainda).

## Interfaces principais

```ts
// src/app.ts
export function startApp(root: HTMLElement): void;

// src/ui/room.ts
export interface OfflineRoom {
  info: RoomInfo;
  tokenCount(): number;
  tokens(): Token[];
  getState(): RoomState;
  apply(delta: Delta): void;
  moveToken(id: string, pos: Point): boolean;
}
export function createOfflineRoom(memberIds: string[]): OfflineRoom;
export type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
export async function joinVia(addr: string, invoke: InvokeFn): Promise<RoomInfo>;
export function replaceDelta(local: RoomState, next: RoomState): Delta;
export function guestJoinNotice(info: RoomInfo): string;
```

## Decisões

- **Detecção Tauri vs browser**: `isTauri()` checa `window.__TAURI__`. Com Tauri, host/join usam invoke real (`create_room`, `join_room`); sem Tauri, o app roda 100% offline com `OfflineRoom` (host simulado local).
- **Ponte invoke sem `@tauri-apps/api`**: `tauriInvoke` lê `window.__TAURI__` diretamente (Tauri 2 expõe `core.invoke`; shims antigos expõem `invoke` top-level). JSON viaja como strings pelos codecs existentes.
- **OfflineRoom**: `createOfflineRoom(memberIds)` semeia um token por membro (`{x: i, y: 0}`, hp 10) sob chaves `token:<id>`. Todas as mutações aplicam via `applyDelta` — mesmo path de produção. `moveToken` usa role `"host"`.
- **Backend (host-side)**: `makeBackend` espelha deltas locais via `push_delta` (best-effort) e puxa snapshot via `get_snapshot` como wholesale replace (`replaceDelta` — upsert snapshot + remove chaves ausentes).
- **Guest não tem estado**: após `join_room`, o guest não armazena `HostState` — `push_delta`/`get_snapshot` ficam host-only. `guestJoinNotice` avisa que push/sync estão desabilitados no guest path.
- **Deltas cross-bridge**: TS `Delta` tem campos opcionais; Rust `decode_delta` exige ambos. `pushDelta` normaliza via `JSON.stringify({ upsert: delta.upsert ?? {}, remove: delta.remove ?? [] })`.
- **Menu**: botão Hospedar chama `create_room` (port 7000); Entrar abre painel IP:Porta e chama `joinVia`; Criar Ficha abre o app offline.

## Pendências

- **Editor de mapa não integrado**: `editor-panel.ts` existe mas não está wireado em `app.ts` (Fase 3 Task 1).
- **Ficha não editável**: painel mostra texto estático; inputs editáveis são Fase 3 Task 2.
- **Dado 3D stub**: `app.ts` usa `frameForResult` do stub; Three.js real é Fase 3 Task 3.
- **Sync live de guest**: guest não mantém estado sincronizado em tempo real — só host emite deltas/snapshots. Guest sync é escopo futuro.
