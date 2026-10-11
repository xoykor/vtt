//! VTT Tauri library root (Fase 2, Task 2).
//!
//! Hosts the pure modules (`net`, `assets`, `save`) so integration tests
//! link `vtt_tauri::...` directly. Everything touching the `tauri` crate
//! sits behind the default-off `tauri-app` feature: `crates.io` is
//! unreachable from the dev sandbox (HTTP 403), so local `cargo test`
//! (default features) never compiles `tauri`; CI resolves and builds
//! `--features tauri-app` with network.

#[allow(dead_code, unused_imports)]
pub mod assets;
#[allow(dead_code, unused_imports)]
pub mod net;
#[allow(dead_code, unused_imports)]
pub mod save;

/// Liveness probe used by `tests/health_test.rs`.
pub fn app_health() -> bool {
    true
}

/// Minimal invoke command proving the Tauri bridge; Task 4 adds asset cmds.
#[cfg(feature = "tauri-app")]
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

/// Binary entry: real Tauri shell when built with `--features tauri-app`.
#[cfg(feature = "tauri-app")]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Offline stub: default features carry no `tauri` dep, so the binary is a
/// placeholder until CI (or a networked checkout) builds `tauri-app`.
#[cfg(not(feature = "tauri-app"))]
pub fn run() {
    println!(
        "vtt-tauri scaffold (rebuild with --features tauri-app for the Tauri shell)"
    );
}
