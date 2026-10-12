# Sheet

## Responsabilidades

Ficha de D&D 5e: tipos, import SRD (Open5e / 5e SRD API), normalização de roll request, serialização como RoomState partition. Sem arte WotC oficial.

## Arquivos

- `src/sheet/types.ts` — `AbilityScores`, `Sheet`, `Roll`, `NormalizedRoll`.
- `src/sheet/srd.ts` — `importMonster`, `fetchSrd`, `rollRequest`, `encodeSheet`/`decodeSheet`, `SrdMonsterEntry`.

## Interfaces principais

```ts
// src/sheet/types.ts
export interface AbilityScores { str: number; dex: number; con: number; int: number; wis: number; cha: number; }
export interface Sheet { id: string; name: string; ac: number; hp: number; maxHp: number; abilities?: AbilityScores; }
export interface Roll { sides: number; count?: number; mod?: number; }
export interface NormalizedRoll { sides: number; count: number; mod: number; }
```

```ts
// src/sheet/srd.ts
export interface SrdMonsterEntry { slug?: unknown; index?: unknown; name?: unknown; armor_class?: unknown; hit_points?: unknown; hit_dice?: unknown; strength?: unknown; dexterity?: unknown; constitution?: unknown; intelligence?: unknown; wisdom?: unknown; charisma?: unknown; }
export function importMonster(entry: SrdMonsterEntry): Sheet;
export async function fetchSrd(slug: string, fetchFn?: FetchLike, cache?: Map<string, Sheet>): Promise<Sheet>;
export function rollRequest(dice: Roll): NormalizedRoll;
export function encodeSheet(sheet: Sheet): string;
export function decodeSheet(json: string): Sheet;
```

## Decisões

- **Import SRD 5.1 via Open5e**: `armor_class` aceita número (Open5e) ou `[{ value }]` (5e SRD API). `hit_points` direto. Habilidades default 10 quando ausentes.
- **Sem arte WotC**: campos `img`, `image` etc. são descartados no import. Sheet carrega stats apenas.
- **Cache local**: `Map<string, Sheet>` keyed por slug. `fetchSrd` aceita `fetchFn` injetável para testes herméticos (sem fetch real em testes).
- **RoomState partition**: sheet viaja como `encodeSheet`/`decodeSheet` — um JSON por chave, aplica via `applyDelta` (mesmo path que tokens/tiles/rolls).
- **Validação no decode**: `decodeSheet` valida os 6 campos de ability quando presentes; `rollRequest` rejeita `sides < 2`, count não-positivo-inteiro.

## Pendências

- **Painel de ficha não editável**: `app.ts` mostra ficha como texto estático (`sheetBox.textContent`). Painel editável com inputs para AC/HP/atributos e condições é Fase 3 Task 2.
- **Sem condições**: `Sheet` não tem campo `conditions` — planejado na Fase 3.
- **Sem wire-up de import SRD no app**: `fetchSrd` existe mas não é chamado pela UI.
