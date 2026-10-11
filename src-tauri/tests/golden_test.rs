//! Cross-boundary golden: Rust `export_json` output feeds the TS E2E path.
//!
//! [`canonical_save`] builds the same 6-piece table the TS harness seeds
//! (`dm` + `p1`..`p5`, token JSON byte-identical to `encodeToken` in
//! `src/map/tokens.ts`). This test regenerates
//! `e2e/fixtures/save-golden.json` deterministically on every run and pins
//! the exact bytes in [`EXPECTED_GOLDEN_JSON`], so any FFI divergence in
//! `export_json` fails here — and `e2e/room.spec.ts` parses the committed
//! fixture through the real `applyDelta`/snapshot path asserting the same
//! 6 ids without duplicates.

#[allow(dead_code)]
#[path = "../src/lib.rs"]
mod main;
use main::save::{export_json, import_json, snapshot, GameSave, SAVE_VERSION};
use std::collections::BTreeMap;

/// Token JSON byte-identical to TS `encodeToken(createToken(id, {x:i,y:0}, 10+i))`.
fn token_json(id: &str, i: u32) -> String {
    format!(
        "{{\"id\":\"{id}\",\"pos\":{{\"x\":{i},\"y\":0}},\"hp\":{}}}",
        10 + i
    )
}

fn canonical_state() -> BTreeMap<String, String> {
    let mut state = BTreeMap::new();
    for (i, id) in ["dm", "p1", "p2", "p3", "p4", "p5"].iter().enumerate() {
        state.insert(id.to_string(), token_json(id, i as u32));
    }
    state
}

fn canonical_save() -> GameSave {
    snapshot("room-7000", SAVE_VERSION, &canonical_state())
}

fn fixture_path() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../e2e/fixtures/save-golden.json")
}

/// Byte-exact `export_json(canonical_save())`. Regenerate by running
/// `cargo test --test golden_test` (rewrites the fixture file too).
const EXPECTED_GOLDEN_JSON: &str = "{\"version\":\"1.0\",\"room\":\"room-7000\",\"state\":{\"dm\":\"{\\\"id\\\":\\\"dm\\\",\\\"pos\\\":{\\\"x\\\":0,\\\"y\\\":0},\\\"hp\\\":10}\",\"p1\":\"{\\\"id\\\":\\\"p1\\\",\\\"pos\\\":{\\\"x\\\":1,\\\"y\\\":0},\\\"hp\\\":11}\",\"p2\":\"{\\\"id\\\":\\\"p2\\\",\\\"pos\\\":{\\\"x\\\":2,\\\"y\\\":0},\\\"hp\\\":12}\",\"p3\":\"{\\\"id\\\":\\\"p3\\\",\\\"pos\\\":{\\\"x\\\":3,\\\"y\\\":0},\\\"hp\\\":13}\",\"p4\":\"{\\\"id\\\":\\\"p4\\\",\\\"pos\\\":{\\\"x\\\":4,\\\"y\\\":0},\\\"hp\\\":14}\",\"p5\":\"{\\\"id\\\":\\\"p5\\\",\\\"pos\\\":{\\\"x\\\":5,\\\"y\\\":0},\\\"hp\\\":15}\"}}";

#[test]
fn golden_fixture_matches_committed_file() {
    let save = canonical_save();
    let json = export_json(&save);
    assert_eq!(json, EXPECTED_GOLDEN_JSON, "golden bytes changed");
    let path = fixture_path();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, &json).unwrap();
    let back =
        import_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(back, save);
    let mut ids: Vec<&String> = back.state.keys().collect();
    ids.sort();
    assert_eq!(ids, vec!["dm", "p1", "p2", "p3", "p4", "p5"]);
}
