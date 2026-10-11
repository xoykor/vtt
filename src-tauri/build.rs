fn main() {
    // Tauri codegen (config/capabilities embedding) only for the real
    // shell; default-features builds skip the `tauri-build` dep entirely.
    #[cfg(feature = "tauri-app")]
    tauri_build::build();
}
