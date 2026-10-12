# Persistence

## Responsabilidades

Save local da sala: backend SQLite (rusqlite) como primário, file backend da Fase 1 mantido para migração, export/import JSON para backup e sharing entre peers.

## Arquivos

- `src-tauri/src/save.rs` — `GameSave`, `SAVE_VERSION`, `SCHEMA_SQL`, `snapshot`, `restore`, `open`, `open_memory`, `save_to_db`, `load_from_db`, `migrate_file`, `export_json`, `import_json`.

## Interfaces principais

```rust
// src-tauri/src/save.rs
pub const SAVE_VERSION: &str = "1.0";
pub const SCHEMA_SQL: &str = "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
pub struct GameSave { pub room: String, pub version: String, pub state: BTreeMap<String, String> }
pub fn snapshot(room: &str, version: &str, state: &BTreeMap<String, String>) -> GameSave;
pub fn restore(save: &GameSave) -> BTreeMap<String, String>;
pub fn open(path: &Path) -> Result<Connection, String>;
pub fn open_memory() -> Result<Connection, String>;
pub fn save_to_db(db: &mut Connection, save: &GameSave) -> Result<(), String>;
pub fn load_from_db(db: &Connection) -> Result<GameSave, String>;
pub fn migrate_file(path: &Path, db: &mut Connection) -> Result<GameSave, String>;
pub fn export_json(save: &GameSave) -> String;
pub fn import_json(json: &str) -> Result<GameSave, String>;
```

## Decisões

- **SQLite primário com bound params**: `save_to_db` usa `params![...]` — nunca string-interpolated SQL. `state` rows são REPLACE wholesale (snapshot menor dropa chaves deletadas); `meta` rows são upsert.
- **File backend Fase 1 mantido**: formato length-prefixed `vtt-save/1\n` com linhas `room <len>\n<bytes>\n`, `save-version`, `entries`, `key <klen> value <vlen>\n<key>\n<value>`. `migrate_file` abre o arquivo e persiste no SQLite em uma transação; erros legíveis para garbage, truncation e version mismatch.
- **Snapshot wholesale**: `restore` substitui o estado local inteiro (clone do BTreeMap). Aplicar o snapshot duas vezes ainda gera exatamente as chaves salvas — tokens nunca duplicam.
- **Export/import JSON manual (std-only)**: `export_json` / `import_json` com parser próprio (sem `serde`). Escape de strings JSON completo (quotes, backslash, control chars, `\uXXXX` com surrogate pairs). Unknown fields ignorados, dupes last-wins.
- **Version check**: `load_from_db` e `import_json` rejeitam versões != `SAVE_VERSION` ("1.0").
- **`sql_quote` / `meta_upsert_sql` / `state_upsert_sql`**: doc-only com `#[deprecated]` — existem para documentar o quoting rule que o SQL implementa, mas o backend real usa bound params.

## Pendências

- **Migração automática não wireada**: `migrate_file` existe mas não é chamado pelo app — o save precisa invocar manualmente ao detectar um arquivo `.sav` antigo.
- **Sem save incremental**: cada save é um truncate-and-rewrite completo; não há journaling ou WAL mode.
