//! Yer imleri: haritada işaretlenen yerler, notlarıyla (“gitmek istediğim
//! yerler” dahil). `bookmarks.json` dosyasında tutulur.

use crate::run_blocking;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub lat: f64,
    pub lon: f64,
    /// Henüz gidilmemiş, gidilmek istenen yer.
    #[serde(default)]
    pub wish: bool,
    #[serde(default)]
    pub created: i64,
}

pub struct BookmarkStore {
    path: PathBuf,
    list: Mutex<Vec<Bookmark>>,
    locked: Option<String>,
}

impl BookmarkStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("bookmarks.json");
        let loaded = crate::store::load_json(&path, "Yer imleri dosyası");
        BookmarkStore {
            path,
            list: Mutex::new(loaded.value),
            locked: loaded.locked,
        }
    }

    pub fn all(&self) -> Vec<Bookmark> {
        self.list.lock().unwrap().clone()
    }

    pub fn set(&self, items: Vec<Bookmark>) -> std::io::Result<()> {
        if let Some(why) = &self.locked {
            return Err(std::io::Error::other(why.clone()));
        }
        let mut list = self.list.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(&items).map_err(std::io::Error::other)?;
        crate::store::write_atomic(&self.path, &bytes)?;
        *list = items;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn get_bookmarks(store: tauri::State<'_, BookmarkStore>) -> Vec<Bookmark> {
    store.all()
}

#[tauri::command]
pub(crate) async fn set_bookmarks(app: AppHandle, items: Vec<Bookmark>) -> Result<(), String> {
    run_blocking(move || {
        app.state::<BookmarkStore>()
            .set(items)
            .map_err(|e| format!("Yer imleri kaydedilemedi: {e}"))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bookmarks_round_trip() {
        let root = std::env::temp_dir().join(format!("gpxer-bm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let s = BookmarkStore::open(&root);
        let b = Bookmark {
            id: "b1".into(),
            name: "Kapadokya".into(),
            note: "balon".into(),
            lat: 38.6,
            lon: 34.8,
            wish: true,
            created: 1,
        };
        s.set(vec![b.clone()]).unwrap();
        assert_eq!(BookmarkStore::open(&root).all(), vec![b]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
