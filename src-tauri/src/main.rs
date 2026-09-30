// Windows'ta release derlemede arka planda konsol penceresi açılmasın.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gpxer_lib::run()
}
