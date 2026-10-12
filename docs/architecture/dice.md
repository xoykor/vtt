# Dice

## Responsabilidades

Resolução de dados host-autorativa: cliente pede, host valida e rola, resultado difundido a todos como delta. Cena stub que mapeia o resultado resolvido para o frame que um renderer deve exibir.

## Arquivos

- `src/dice/roller.ts` — `RollResult`, `RngLike`, `resolveRoll`, `encodeRollResult`/`decodeRollResult`, `rollResultKey`, `publishRoll`.
- `src/dice/scene.ts` — `DiceFaceView`, `DiceSceneFrame`, `frameForResult`, `createDiceScene` (stub puro, sem WebGL).

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
- **Three.js stub**: `scene.ts` é puro (sem DOM/WebGL). `frameForResult` mapeia resultado -> frame com labels `d<sides>:<value>`. Three.js real (`three-view.ts`) é Fase 3 Task 3 — consome `frameForResult`/`createDiceScene` e anima até as faces.

## Pendências

- **Three.js não implementado**: `three-view.ts` não existe; `scene.ts` é stub puro. Fase 3 Task 3.
- **Sem física**: decisão deliberada — Three.js só renderiza o resultado resolvido, sem engine de física.
- **Roll local no offline**: `app.ts` resolve roll localmente via `resolveRoll` (host simulado) e aplica via `room.apply(delta)` — não usa o bridge invoke.
