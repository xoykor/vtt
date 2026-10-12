//! SQLite backend roundtrip (Fase 2, Task 5).
//!
//! Pins the rusqlite migration: the six-token canonical state
//! (same shape as `tests/golden_test.rs`) survives a
//! save → restore_all roundtrip through the SQLite backend.
//! Every value travels as a bound parameter (no
//! string-interpolated SQL), saves replace state wholesale
//! (deleted keys drop), and the phase-1 file backend either
//! migrates or yields its readable error.

#[allow(dead_code)]
#[path = "../src/lib.rs"]
mod main;
use main::save::{
    load_from_db, migrate_file, open, open_memory, restore_all, save_to_db,
    save_to_file, snapshot, SAVE_VERSION,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Same six pieces as `tests/golden_test.rs` (`dm` + `p1`..`p5`).
fn six_token_state() -> BTreeMap<String, String> {
    let mut state = BTreeMap::new();
    for (i, id) in ["dm", "p1", "p2", "p3", "p4", "p5"].iter().enumerate() {
        state.insert(
            id.to_string(),
            format!(
                "{{\"id\":\"{id}\",\"pos\":{{\"x\":{i},\"y\":0}},\"hp\":{}}}",
                10 + i
            ),
        );
    }
    state
}

fn temp_path() -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "vtt-sqlite-test-{}-{n}.sav",
        std::process::id()
    ))
}

#[test]
fn sqlite_roundtrip_six_tokens() {
    let mut db = open_memory().unwrap();
    let save = snapshot("room-7000", SAVE_VERSION, &six_token_state());
    save_to_db(&mut db, &save).unwrap();
    assert_eq!(restore_all(&db).unwrap().len(), 6);
}

#[test]
fn sqlite_load_returns_the_saved_snapshot() {
    let mut db = open_memory().unwrap();
    let save = snapshot("room-7000", SAVE_VERSION, &six_token_state());
    save_to_db(&mut db, &save).unwrap();
    assert_eq!(load_from_db(&db).unwrap(), save);
}

#[test]
fn sqlite_replace_drops_deleted_keys() {
    // Snapshot semantics: re-saving a smaller snapshot removes
    // the stale rows instead of merging them in.
    let mut db = open_memory().unwrap();
    save_to_db(
        &mut db,
        &snapshot("room-7000", SAVE_VERSION, &six_token_state()),
    )
    .unwrap();
    let mut trimmed = six_token_state();
    trimmed.remove("p4");
    trimmed.remove("p5");
    save_to_db(
        &mut db,
        &snapshot("room-7000", SAVE_VERSION, &trimmed),
    )
    .unwrap();
    let state = restore_all(&db).unwrap();
    assert_eq!(state.len(), 4);
    assert!(!state.contains_key("p4"));
    assert!(!state.contains_key("p5"));
}

#[test]
fn sqlite_binds_quotes_and_emoji_without_string_sql() {
    // Values that would break interpolated SQL roundtrip intact:
    // the backend binds parameters, it never quotes them in.
    let mut db = open_memory().unwrap();
    let mut state = six_token_state();
    state.insert("weird \"key\" \\ é".to_string(), "O'Brien\n😀".to_string());
    let save = snapshot("room \"7000\" \\ é", SAVE_VERSION, &state);
    save_to_db(&mut db, &save).unwrap();
    assert_eq!(load_from_db(&db).unwrap(), save);
    assert_eq!(restore_all(&db).unwrap().len(), 7);
}

#[test]
fn sqlite_load_rejects_missing_meta_and_bad_version() {
    let mut db = open_memory().unwrap();
    let err = load_from_db(&db).unwrap_err();
    assert!(err.contains("missing field: room"), "got: {err}");
    let save = snapshot("room-7000", "9.9", &six_token_state());
    save_to_db(&mut db, &save).unwrap();
    let err = load_from_db(&db).unwrap_err();
    assert!(err.contains("version mismatch"), "got: {err}");
}

#[test]
fn sqlite_open_persists_across_connections() {
    let path = temp_path();
    {
        let mut db = open(&path).unwrap();
        save_to_db(
            &mut db,
            &snapshot("room-7000", SAVE_VERSION, &six_token_state()),
        )
        .unwrap();
    }
    let db = open(&path).unwrap();
    assert_eq!(restore_all(&db).unwrap().len(), 6);
    std::fs::remove_file(&path).ok();
}

#[test]
fn sqlite_migrates_phase1_file_or_errors_readably() {
    let mut db = open_memory().unwrap();
    let save = snapshot("room-7000", SAVE_VERSION, &six_token_state());
    let path = temp_path();
    save_to_file(&path, &save).unwrap();
    // Phase-1 file opens and its rows land in the SQLite backend.
    assert_eq!(migrate_file(&path, &mut db).unwrap(), save);
    assert_eq!(restore_all(&db).unwrap().len(), 6);
    std::fs::remove_file(&path).ok();
    // Garbage never migrates: the readable phase-1 error returns.
    for bad in ["not a save file\n", "vtt-save/2\n", ""] {
        std::fs::write(&path, bad).unwrap();
        let err = migrate_file(&path, &mut db).unwrap_err();
        assert!(
            err.contains("malformed save file"),
            "input {bad:?} gave: {err}"
        );
    }
    std::fs::remove_file(&path).ok();
}
