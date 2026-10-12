# Ficha individual por player — relatório

Branch `feat/vtt-sheet-rework` (base `15d39fc`). Só foi tocado o worktree
`.worktrees/feat-sheet`; `/home/x/Documentos/VTT` ficou intacto.

## Item 1 — Hospedar sem Tauri (bug, feito)

Reprodução: `startApp` no browser puro, clique em Hospedar. O `onHost`
já desviava antes do `tauriInvoke`, então nada estourava — mas a mensagem
(`"Modo offline: hospedagem requer Tauri."`) não dizia como rodar o app.

Correção (`src/app.ts`): sem bridge, o status agora mostra exatamente

> Hospedar requer o app Tauri — rode `npm run tauri dev` ou use o instalador

exportada como `HOST_UNAVAILABLE_MESSAGE`, com classe de erro e o menu
permanecido aberto. Com Tauri, o fluxo segue criando a sala de verdade via
`create_room` (sem alteração — já era o comportamento).

Teste: `src/app.test.ts` (jsdom) — clique sem Tauri mostra a mensagem;
com `__TAURI__` simulado, `create_room` é chamado e a mesa abre.

## Item 2 — ficha individual por player (feito)

- Modelo (`src/sheet/types.ts`): `Sheet` ganha `ownerId`, `level`,
  `charClass`, `profBonus` (opcionais para não quebrar imports SRD nem os
  testes antigos). `profBonusForLevel` (`src/sheet/level.ts`):
  `2 + floor((level-1)/4)`, com clamp e fail-closed em não-finito.
- Visibilidade (`src/sheet/visibility.ts`): `sheetKey(id)` → `sheet:<id>`
  (mesma convenção de `token:`/`roll:`); `visibleSheets(state, role, userId)`
  devolve tudo ao host e só `sheet:<userId>` + `sheet:public:*` ao guest —
  tokens/rolls passam intactos. Coberta por `visibility.test.ts`.
- Criação (`src/ui/sheet-creator.ts` + `showSheetCreator` em `src/app.ts`):
  rota fullscreen separada, sem grid/mapa, com as abas
  Atributos | Perícias | Magias/Equip | Bio/Notas e proficiência derivada
  ao vivo. Salvar cria o `Sheet` com `ownerId` (seletor de membro), guarda
  em `sheets` e abre a mesa; cancelar volta ao menu (novo `Menu.show()`).
- Mesa (`src/ui/app-shell.ts`, `src/ui/token-bar.ts`): guest vê só o botão
  da própria ficha; host mantém o seletor completo. Deltas de ficha viajam
  como `sheet:<id>`; `pullSnapshot` filtra o snapshot do guest via
  `visibleSheets`. `Session` ganha `userId`. Filtragem por-peer no transporte
  (host → guest específico) ainda exige suporte no backend Rust — registrado
  como próximo passo, a função pura já está pronta para ele.
- `decodeSheet`/`cloneSheet` (`src/sheet/srd.ts`): round-trip de todos os
  campos (entradas ruins são ignoradas, o sync nunca trava); clone profundo.

## Item 3 — ficha completa estilo Roll20 (feito)

- Campos (`src/sheet/types.ts`): raça, alinhamento, XP, inspiração,
  deslocamento, `initiativeMisc`, HP temp, death saves, ataques
  (nome/bônus/dano), magias (nome/nível), slots (nível/total/usados),
  dinheiro (cp/sp/ep/gp/pp), idiomas, história.
- Painel (`src/ui/sheet-panel.ts`): header Roll20
  (nome/classe/nível/raça/alinhamento/XP) + abas Core | Bio | Magias/Equip.
  Nível recalcula a proficiência ao vivo. Rolagens passam por `rollRequest`
  + `resolveRoll`; a última rolagem aparece no painel com destaque de
  crítico 20 / falha 1. `rng` injetável nos callbacks para testes.
- CSS (`src/styles/sheet.css`): abas, bloco de combate, linha de rolagem
  e novos campos na paleta taverna (verde/dourado, Cinzel).

## Validação

- `npx vitest run` → 19 arquivos, 151 testes, todos verdes (base: 14/126).
- `npm run typecheck` (`tsc --noEmit`) → limpo.
- Smoke: `npx vite --port 5198` serviu `index 200` + transform de
  `src/app.ts`; servidor desligado em seguida (o dev da pasta principal,
  porta 5199, não foi tocado).

## Commits (todos em inglês, pequenos)

1. `68454dd` fix(menu): show Tauri setup hint when hosting outside the app
2. `6427493` feat(sheet): owner, level, class and derived proficiency bonus
3. `6da3524` feat(sheet): namespaced sheet keys and guest visibility filter
4. `ba4bcc4` feat(sheet): full Roll20 combat fields with tolerant decode
5. `0f4143e` feat(ui): fullscreen sheet creator and role-aware table
6. `cf64530` feat(ui): tabbed Roll20 sheet with combat, crit highlight
