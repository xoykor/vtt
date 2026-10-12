# Map

## Responsabilidades

Grid de jogo, fog of war, iluminação, tokens e editor de tiles. Fornece a geometria pura (sem rendering) que a view consome, e o editor host-autorativo de tiles com assets por hash.

## Arquivos

- `src/map/grid.ts` — `Grid`, `Point`, `createGrid`, `inBounds`, `toIndex`, `cellCenter`. Células são quadrados unitários: célula `(x,y)` span `[x,x+1] x [y,y+1]`, centro `(x+0.5, y+0.5)`.
- `src/map/fog.ts` — `Fog` (máscara booleana), `createFog`, `pointInPolygon` (ray-casting even-odd), `revealFog` (revela células cujo centro cai dentro do polígono; fog é sticky — revelar nunca re-fog).
- `src/map/light.ts` — `LightMap` (máscara de paredes), `LightSource`, `computeLight` (célula iluminada se dentro do raio e sem parede no caminho; amostragem 4 samples/célula).
- `src/map/tokens.ts` — `Token` (id, pos, hp), `createToken`, `encodeToken`/`decodeToken`, `moveToken(state, id, pos, role)` — só host escreve, `ok: false` para roles não-host.
- `src/map/editor.ts` — `Tile` (x, y, layer, asset), `GameMap`, `createMap`, `tileKey` (`tile:<layer>:<x>,<y>`), `placeTile(map, tile, role)` — só host, `assetHash` SHA-256 manual, cache local `Map<string, Uint8Array>`.
- `src/ui/mapview.ts` — `renderMapView(canvas, data)` — canvas 2D: grid + fog + luz + tokens (círculos rotulados, sem arte). `CELL = 32`.
- `src/ui/editor-panel.ts` — `renderEditorPanel(container, map, onPlace)` — painel host-only: seletor de camada (floor/wall/asset), botão "Colocar tile" que chama `placeTile` real, lista de tiles.

## Interfaces principais

```ts
// src/map/editor.ts
export interface Tile { x: number; y: number; layer: string; asset: string; }
export interface GameMap { width: number; height: number; tiles: Record<string, string>; }
export function createMap(width: number, height: number): GameMap;
export function tileKey(tile: Tile): string;  // "tile:<layer>:<x>,<y>"
export function placeTile(map: GameMap, tile: Tile, role: string): PlaceResult;
export function assetHash(bytes: Uint8Array): string;
export function createAssetCache(): Map<string, Uint8Array>;
```

```ts
// src/map/tokens.ts
export interface Token { id: string; pos: Point; hp: number; }
export function moveToken(state: Record<string, string>, id: string, pos: Point, role: string): MoveResult;
```

```ts
// src/map/fog.ts
export function revealFog(fog: Fog, polygon: Point[]): Fog;
```

```ts
// src/map/light.ts
export function computeLight(map: LightMap, sources: LightSource[]): boolean[];
```

## Decisões

- **Host autoritativo fail-closed**: `placeTile` e `moveToken` retornam `ok: false` para qualquer role não-host. Jogador pede ao mestre.
- **Assets por SHA-256**: endereçamento por conteúdo, cache local `Map<string, Uint8Array>`. `assetHash` em TS espelha `asset_hash` em Rust — ambos devem emitir hex idêntico para os mesmos bytes.
- **Tiles como RoomState partition**: `tile:<layer>:<x>,<y>` -> JSON Tile. Deltas de `placeTile` aplicam via `applyDelta` do mesmo path que tokens.
- **Fog sticky**: `revealFog` nunca re-fog; revelar é permanente. Ray-casting point-in-polygon even-odd rule.
- **Luz por amostragem**: 4 samples por célula no segmento fonte->célula; barato e hermético sem edge cases de rasterização de linha float.
- **Canvas 2D, sem WebGL**: tokens são círculos rotulados, sem arte. Mapa usa `renderMapView` local.

## Pendências

- **Editor de mapa não integrado ao app**: `editor-panel.ts` existe mas não está wireado em `app.ts` (Fase 3 Task 1).
- **Sem renderização de tiles no canvas**: `mapview.ts` desenha tokens mas não tiles do `GameMap`.
- **Sem paredes no editor**: `computeLight` aceita máscara de paredes mas não há UI para desenhar paredes.
