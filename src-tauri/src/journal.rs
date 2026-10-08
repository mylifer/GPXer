//! Günlük notları: kayda değil güne yazılan notlar ("Babamla Datça'ya
//! gittik"). `gunluk.json`: gün (yyyy-aa-gg) → metin. Eşitlenir, yedeklenir.

use crate::run_blocking;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub struct JournalStore {
    path: PathBuf,
    days: Mutex<BTreeMap<String, String>>,
    locked: Option<String>,
}

/// Gün anahtarı geçerli mi (yyyy-aa-gg).
fn valid_day(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && d.chars()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

impl JournalStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("gunluk.json");
        let loaded = crate::store::load_json(&path, "Günlük dosyası");
        JournalStore {
            path,
            days: Mutex::new(loaded.value),
            locked: loaded.locked,
        }
    }

    pub fn all(&self) -> BTreeMap<String, String> {
        self.days.lock().unwrap().clone()
    }

    /// Bütün günleri yazar (boş metinli günler atılır).
    pub fn set_all(&self, mut days: BTreeMap<String, String>) -> std::io::Result<()> {
        if let Some(why) = &self.locked {
            return Err(std::io::Error::other(why.clone()));
        }
        days.retain(|d, t| valid_day(d) && !t.trim().is_empty());
        let mut cur = self.days.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(&days).map_err(std::io::Error::other)?;
        crate::store::write_atomic(&self.path, &bytes)?;
        *cur = days;
        Ok(())
    }

    pub fn set_day(&self, day: &str, text: &str) -> std::io::Result<()> {
        if !valid_day(day) {
            return Err(std::io::Error::other("Geçersiz gün"));
        }
        let mut all = self.all();
        if text.trim().is_empty() {
            all.remove(day);
        } else {
            all.insert(day.to_owned(), text.to_owned());
        }
        self.set_all(all)
    }
}

#[tauri::command]
pub(crate) fn get_journal(store: tauri::State<'_, JournalStore>) -> BTreeMap<String, String> {
    store.all()
}

#[tauri::command]
pub(crate) async fn set_day_note(app: AppHandle, day: String, text: String) -> Result<(), String> {
    run_blocking(move || {
        app.state::<JournalStore>()
            .set_day(&day, &text)
            .map_err(|e| format!("Günlük kaydedilemedi: {e}"))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_removes_day_notes() {
        let dir = std::env::temp_dir().join(format!("gpxer-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = JournalStore::open(&dir);
        s.set_day("2024-07-09", "Babamla Datça'ya gittik").unwrap();
        assert!(s.set_day("09.07.2024", "x").is_err());
        let s = JournalStore::open(&dir);
        assert_eq!(
            s.all().get("2024-07-09").map(String::as_str),
            Some("Babamla Datça'ya gittik")
        );
        s.set_day("2024-07-09", "  ").unwrap();
        assert!(JournalStore::open(&dir).all().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
