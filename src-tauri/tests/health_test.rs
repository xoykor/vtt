#[allow(dead_code)]
#[path = "../src/lib.rs"]
mod main;
use main::app_health;

#[test]
fn app_boots_with_health_ok() {
    assert_eq!(app_health(), true);
}

#[test]
fn lib_exposes_net_and_save() {
    assert!(vtt_tauri::net::PROTOCOL_VERSION_MAJOR >= 1);
    assert_eq!(vtt_tauri::save::SAVE_VERSION, "1.0");
}
