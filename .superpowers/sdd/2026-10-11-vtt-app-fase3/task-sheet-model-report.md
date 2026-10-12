# Novo modelo de sessão/fichas (Roll20/Foundry, sem slots) — relatório

Branch `feat/vtt-sheet-model` (base `e426bd4`). Trabalho SOMENTE em
`/home/x/Documentos/VTT/.worktrees/feat-model`; pasta principal intacta.

## Status: feito

Modelo sem slots fixos, sem limite, sem seletor de jogador. Quem hospeda = GM;
quem entra com código = player. Fichas `sheet:<id>` com ACL dupla, tokens com
`represents` + herança, `user.character` p/ falar/rolar. Rede intacta
(`RoomState`/`Delta` inalterados; sessão/peers em memória).

## Regras (todas atendidas)

1. **Sem slots, sem limite, sem seletor.** Removidos: `MEMBERS` (`dm,p1..p5`),
   `ownerSelect` (`.creator-owner`), `visibleMembers`/`selected` por membro.
   Barra agora lista fichas visíveis (dinâmica); sala inicia vazia
   (`createOfflineRoom([])`); `createMemberSheets` virou legado vazio
   (`createEmptySheets` no lugar).
2. **`peers[] = {peerId, displayname, isGM}`** (`src/session/peers.ts` +
   `OfflineRoom.peers/addPeer/removePeer`). `peerId` = slug do nome +
   hash (`nome-xxxx`); host = GM inicial; convite = `sala#segredo`
   (`inviteCode/parseInviteCode`); kick = `removePeer` + `rotateSecret`.
   Em memória (RoomState/delta intactos p/ mapa/dados/rede).
3. **ACL dupla** (`src/sheet/acl.ts`, `src/sheet/types.ts`): `viewers[]`
   (só metadados nome/avatar/bio via `toMetadata`), `controllers[]`
   (completa+bio+tokens+falar como), `publicView/publicControl` = todos,
   GM bypassa (`canView/canControl`), `gmNotes` nunca p/ não-GM
   (`stripGmNotesForPeer`, `filterSheetForPeer`, `visibleSheets` filtra na
   ingestão). `decodeSheet` tolerante p/ ACL + `gmNotes`.
4. **Criação em tela cheia com abas** (reutilizado `src/ui/sheet-creator.ts`,
   sem criar novo arquivo). Player cria própria (auto `controllers=[creator]`,
   sem UI de ACL); GM cria p/ qualquer um (UI `creator-share`:
   `publicView/publicControl` + viewers/controllers por peer + `gmNotes`).
   `sanitizeSheetWrite` trava ACL + `gmNotes` p/ não-GM (fail-closed).
5. **`user.character: sheetId|null`** (`Session.character` em
   `src/ui/app-shell.ts`). Seleção define `character` (padrão p/ falar/rolar;
   dados e rolagens prefixam o nome). GM vê todas (`visibleSheetsForSession`
   + `visibleSheets` p/ GM = todas); player vê próprias + compartilhadas.
6. **Token `{represents: sheetId|null}`** (`src/map/tokens.ts` tolerante) +
   `canControlToken` (herança; sem ficha = só GM). Clique no mapa move o
   token da ficha selecionada se controlável; legado `id === selected` mantido.
7. **Chaves existentes**: fichas `sheet:<id>` (`sheetKey`), sem mudar formato
   de rede. Outras partições (`token:`, `tile:`, `roll:`) passam intactas.

## Arquivos

- Novo: `src/sheet/acl.ts`, `src/session/peers.ts`
- Modelo: `src/sheet/types.ts` (+`viewers/controllers/public*/gmNotes`),
  `src/sheet/srd.ts` (decode ACL/gmNotes + stats tolerantes p/ metadados),
  `src/map/tokens.ts` (+`represents`)
- Visibilidade: `src/sheet/visibility.ts` (ACL + metadados + sem `gmNotes`,
  legado `sheet:<userId>/ownerId/sheet:public:*` preservado verbatim)
- Sessão: `src/ui/room.ts` (peers/secret em memória + `peerKey/inviteCodeFor`),
  `src/ui/app-shell.ts` (`Session` com `peerId/displayName/isGM/character/peers`,
  barra de fichas, `sanitize` + `room.apply` local, `refreshSheets`),
  `src/app.ts` (sala vazia, `syncSheetsFromRoom`, criador com autor + token
  vinculado, `character` inicial, convite no status)
- UI sem seletor: `src/ui/token-bar.ts` (itens dinâmicos + `setItems`),
  `src/ui/sheet-creator.ts` (sem `ownerSelect`, ACL só GM)

## TDD (teste novo primeiro)

- `src/sheet/acl.test.ts`: guest não vê alheia; GM vê todas; player cria com
  `controllers=[self]`; ACL de não-GM ignorada; GM escreve livre; viewers só
  metadados; controllers sem `gmNotes` p/ não-GM; `gmNotes` filtrado;
  token herda; `gmNotes` de não-GM ignorado.
- `src/session/peers.test.ts`: host GM + `peerId` com hash+nome; join vira
  player; ilimitado + kick + `rotateSecret`; código malformado rejeita.
- `src/sheet/visibility-acl.test.ts`: GM vê todas (com `gmNotes`); guest não
  vê alheia; player vê próprias + compartilhadas (viewer=metadados,
  controlador=completa); `gmNotes` nunca p/ não-GM.
- `src/ui/room-peers.test.ts`: sala vazia sem slots; `peerId` com nome;
  kick; convite `sala#segredo` + rotação; peers em memória sem poluir tokens.
- `src/ui/app-shell-sheet-model.test.ts`: GM vê todas; player só
  próprias+compartilhadas; sem botões `dm/p1`; clique define `character`;
  `sheet:<id>` intacto.
- Atualizados p/ novo modelo: `src/ui/room.test.ts` (inalterado após
  mover peers p/ memória), `src/ui/sheet-creator.test.ts` (sem seletor,
  `controllers=[self]`, ACL só GM), `src/sheet/visibility.test.ts` intacto
  (legado passa via verbatim).

## Validação

- `npx vitest run` → 24 arquivos, 178 testes, todos verdes (base: 19/151).
- `npm run typecheck` (`tsc --noEmit`) → limpo.
- Mapa/dados/rede intactos: `map-editor.test.ts`, `tokens.test.ts`,
  `peer.test.ts`, `roller/three-scene` verdes; nenhum `src-tauri` tocado.

## Commits (pequenos, em inglês)

1. `c1d2ba3` feat: sheet ACL model with viewers/controllers and token inheritance
2. `bbce157` feat: session without slots and creator without player selector
3. `0f62ff0` feat: sheet-model wiring with character and token inheritance

## Próximos (fora do escopo)

- Nome auto-declarado editável no menu (hoje `Mestre`/`Jogador` padrão).
- Edição de ACL pós-criação no painel (hoje só no criador; `sanitize` já trava).
- Sync player→host de edições (hoje `push` só GM; guest `push/sync` desabilitados).
- Filtragem por-peer no backend Rust (pura `visibleSheets` pronta).
