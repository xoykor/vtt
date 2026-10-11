#[path = "../src/main.rs"]
mod main;
use main::app_health;

#[test]
fn app_boots_with_health_ok() {
    assert_eq!(app_health(), true);
}
