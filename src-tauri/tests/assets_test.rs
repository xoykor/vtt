#[allow(dead_code)]
#[path = "../src/main.rs"]
mod main;
use main::assets::{asset_hash, verify_asset, AssetCache};

#[test]
fn bad_hash_triggers_redownload() {
    let bytes = b"tile pixels".to_vec();
    assert!(verify_asset(&bytes, "deadbeef").is_err());
}

#[test]
fn asset_hash_matches_sha256_vector() {
    assert_eq!(
        asset_hash(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        asset_hash(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
}

#[test]
fn verify_asset_accepts_matching_hash() {
    let bytes = b"tile pixels".to_vec();
    let hash = asset_hash(&bytes);
    assert!(verify_asset(&bytes, &hash).is_ok());
    // Hex em maiúsculas também verifica (normalizado antes de comparar).
    assert!(verify_asset(&bytes, &hash.to_ascii_uppercase()).is_ok());
}

#[test]
fn asset_cache_stores_bytes_under_hash() {
    let mut cache = AssetCache::new();
    let bytes = b"grass pixels".to_vec();
    let hash = cache.insert(&bytes);
    assert_eq!(hash, asset_hash(&bytes));
    assert_eq!(cache.get(&hash), Some(bytes.as_slice()));
    assert_eq!(cache.get("deadbeef"), None);
}
