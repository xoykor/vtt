# Fix round 1 — modelo sessão/ficha sem slots (relatório)

Branch `feat/vtt-sheet-model`, base `bb85828`. Somente
`/home/x/Documentos/VTT/.worktrees/feat-model`; nada além dos fixes abaixo.

## TDD

Regressão escrita antes do fix (9 testes, 9 falhas antes, 9 verdes depois):
- `src/sheet/model-fix-round1.test.ts` — Critical 1 (2), Critical 2 (2), Important 3 (2)
- `src/ui/shell-fix-round1.test.ts` — Important 1/2/4 (3; Important 4 exigiu
  exportar `syncSheetsFromRoom`, então falhava com `not a function` antes)

## Fixes (verbatim, todos)

- **Critical 1** (`src/sheet/acl.ts`, `sanitizeSheetWrite`): trava `ownerId`
  p/ não-GM — criação força `ownerId=author.peerId`; edição preserva
  `prev.ownerId` (ou dropa). Fecha escalação via caminho legado
  `canView`/`canControl`.
- **Critical 2** (`src/sheet/visibility.ts`, catch de decode): fallback
  `isPublicLegacy||isOwnKey` agora faz `JSON.parse` + `delete raw.gmNotes`
  + re-stringify; nem-JSON é dropado. Nada verbatim com `gmNotes` (fail-closed).
- **Important 1** (`src/ui/app-shell.ts`, `visibleSheetsForSession`): retorna
  `filterSheetForPeer(...)` não-nulo — viewer recebe metadados, não a completa.
- **Important 2** (`src/ui/app-shell.ts`, `showSheet`): renderiza a projeção
  filtrada; viewer (vê, não controla) ganha painel somente-leitura da
  projeção com `onChange` que não persiste (sem corromper stats reais).
- **Important 3** (`src/sheet/visibility.ts`, verbatim): `wireHasGmNotes(value)`
  (parse + `hasOwnProperty`, ilegível = suspeito) — verbatim só quando
  controlador + `sheet.gmNotes===undefined` + sem chave no wire.
  `gmNotes:null`/number não passa mais.
- **Important 4** (`src/app.ts`, `syncSheetsFromRoom`, agora exportada):
  `sheet:public:foo` → id `foo` (normal vence se ambas existirem; vazio pula);
  nunca cria id `public:foo`.
- **Minors**: `@deprecated use items` no `members` de `token-bar.ts`;
  criação player normaliza `viewers=[]` sempre (fim da inconsistência [] vs
  undefined em `acl.ts`).

## Validação

- `npx vitest run` → 26 arquivos, 187 testes, todos verdes (base 178 + 9 novos).
- `npm run typecheck` (`tsc --noEmit`) → limpo, exit 0.
- Mapa/dados/rede intactos: nenhum `src-tauri` tocado; `map-editor`,
  `tokens`, `peer`, `roller` verdes.
