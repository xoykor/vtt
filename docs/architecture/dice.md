# Dice

## Responsabilidades

Resolução de dados host-autorativa: cliente pede, host valida e rola, resultado difundido a todos como delta. Cena stub que mapeia o resultado resolvido para o frame que um renderer deve exibir.

## Arquivos

- `src/dice/roller.ts` — `RollResult`, `RngLike`, `resolveRoll`, `encodeRollResult`/`decodeRollResult`, `rollResultKey`, `publishRoll`.
- `src/dice/scene.ts` — `DiceFaceView`, `DiceSceneFrame`, `frameForResult`, `createDiceScene` (stub puro, sem WebGL).
- `src/dice/die-geometry.ts` — geometria dos dados: tabela de faces por tamanho (box, tetraedro, octaedro, trapezoedro, dodecaedro, icosaedro, moeda), geometria flat-shaded com UVs por face num atlas de canvas, e o quaternion que aponta a face sorteada para cima mantendo o número legível. Puro — sem DOM nem WebGL.
- `src/dice/three-scene.ts` — `createThreeDiceView(container)`: cena three.js + fallback numérico.

## Interfaces principais

```ts
// src/dice/roller.ts
export interface RollResult { sides: number; count: number; mod: number; rolls: number[]; total: number; }
export type RngLike = () => number;
export const MAX_DICE_COUNT = 100;
export function resolveRoll(req: Roll, rng?: RngLike): RollResult;
export function encodeRollResult(result: RollResult): string;
export function decodeRollResult(json: string): RollResult;
export function rollResultKey(id: string): string;  // "roll:<id>"
export function publishRoll(result: RollResult, id: string): Delta;
```

```ts
// src/dice/die-geometry.ts
export interface DieFace { normal: Vector3; tangent: Vector3; right: Vector3; triangles: Vector3[][]; labeled: boolean; }
export const MESHABLE_SIDES = [2, 4, 6, 8, 10, 12, 20] as const;
export function buildDieFaceTable(sides: number, screenUp?: Vector3): DieFace[];
export function defaultFaceLabels(sides: number): (string | null)[];
export function buildDieAtlas(table: DieFace[], labels: (string | null)[]): HTMLCanvasElement;
export function buildDieGeometry(table: DieFace[], labels: (string | null)[]): BufferGeometry;
export function faceAimQuaternion(face: DieFace, screenUp?: Vector3): Quaternion;
export function createDieMaterial(atlas: HTMLCanvasElement): MeshStandardMaterial;
```

```ts
// src/dice/three-scene.ts
export type DiceViewMode = "webgl" | "numeric";
export const MAX_3D_DICE = 8;
export function percentileParts(value: number): { tens: number; units: number };  // d100 -> dois d10
export function planDice(frame: DiceSceneFrame, max?: number): DicePlan[];
export function createThreeDiceView(container: HTMLElement, options?: { hasWebGL?: () => boolean }): ThreeDiceView;
// { show(frame | RollResult), dispose(), current(), mode() }
```

```ts
// src/dice/scene.ts
export interface DiceFaceView { die: number; sides: number; value: number; faceIndex: number; label: string; }
export interface DiceSceneFrame { sides: number; faces: DiceFaceView[]; total: number; }
export function frameForResult(result: RollResult): DiceSceneFrame;
export function createDiceScene(): DiceScene;
```

## Decisões

- **Host autoritativo**: só o host chama `resolveRoll`. Cliente pede via delta; host valida e difunde `publishRoll` como delta (`roll:<id>`).
- **Dados padrão de mesa**: d2-d20 mais d100 (percentile). `sides > 20 && sides !== 100` rejeitado — não corresponde a dado físico.
- **RNG injetável**: `RngLike` default `Math.random`; testes passam stub hermético. Output validado em `[0, 1)`; clamp guards contra `1 - epsilon`.
- **Validação no decode**: `decodeRollResult` checa `rolls.length === count`, faces em `[1, sides]`, `total === sum + mod`.
- **Three.js só renderiza**: `three-scene.ts` consome `frameForResult`/`createDiceScene` e gira o mesh até a face do frame. Um rolo = um quaternion por dado; sem física e sem rolagem própria.
- **Atlas único por tipo de dado**: cada face aponta para uma célula do atlas com seu número; a face de cima mostra o valor sorteado e a rotação de aterrissagem é curta (520 ms, wobble determinístico).
- **Percentile em dois dados**: d100 vira dois d10 (dezenas 00..90 + unidades 0..9), como os dados físicos.
- **Fallback numérico**: sem contexto WebGL utilizável (jsdom/CI/sem GPU) a view cai para o readout numérico já existente (`d20:15 = 15`) e nunca lança — a probe tem `hasWebGL` injetável para testar os dois caminhos.

## Pendências

- **Sem física**: decisão deliberada — Three.js só renderiza o resultado resolvido, sem engine de física.
- **Integração no shell**: `three-scene.ts` ainda não é montado em `ui/app-shell.ts` (o painel segue com o readout de texto).
- **Roll local no offline**: `app.ts` resolve roll localmente via `resolveRoll` (host simulado) e aplica via `room.apply(delta)` — não usa o bridge invoke.
