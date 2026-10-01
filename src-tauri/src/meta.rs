//! Kayıtlara kullanıcının eklediği bilgiler: etiketler, not ve etkinlik türü.
//! Kütüphane yoluna göre `meta.json` dosyasında tutulur.

use gpx_core::Activity;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileMeta {
    pub tags: Vec<String>,
    pub note: String,
    /// Kullanıcının seçtiği tür; yoksa tahmin kullanılır.
    pub activity: Option<Activity>,
}

impl FileMeta {
    fn is_empty(&self) -> bool {
        self.tags.is_empty() && self.note.trim().is_empty() && self.activity.is_none()
    }
}

pub struct MetaStore {
    path: PathBuf,
    map: Mutex<HashMap<String, FileMeta>>,
}

impl MetaStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("meta.json");
        let map = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        MetaStore {
            path,
            map: Mutex::new(map),
        }
    }

    pub fn all(&self) -> HashMap<String, FileMeta> {
        self.map.lock().unwrap().clone()
    }

    pub fn activity(&self, path: &str) -> Option<Activity> {
        self.map.lock().unwrap().get(path).and_then(|m| m.activity)
    }

    fn save(&self, map: &HashMap<String, FileMeta>) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(map).map_err(std::io::Error::other)?;
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &self.path)
    }

    /// Kaydın bilgilerini değiştirir; önceki halini döndürür.
    pub fn set(&self, path: &str, mut meta: FileMeta) -> std::io::Result<FileMeta> {
        meta.tags = clean_tags(meta.tags);
        let mut map = self.map.lock().unwrap();
        let old = if meta.is_empty() {
            map.remove(path)
        } else {
            map.insert(path.to_owned(), meta)
        }
        .unwrap_or_default();
        self.save(&map)?;
        Ok(old)
    }

    /// Dosya yeni bir ada taşındığında (çöp kutusundan geri gelirken) bilgileri taşır.
    pub fn rename(&self, from: &str, to: &str) {
        let mut map = self.map.lock().unwrap();
        if let Some(m) = map.remove(from) {
            map.insert(to.to_owned(), m);
            let _ = self.save(&map);
        }
    }
}

/// Türkçe kurallarıyla küçük harf (İ → i, I → ı).
fn tr_lower(s: &str) -> String {
    s.replace('İ', "i").replace('I', "ı").to_lowercase()
}

/// Boşlukları kırpar, boşları ve tekrarları atar; sırayı korur.
fn clean_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim().to_owned();
        if !t.is_empty() && !out.iter().any(|x| tr_lower(x) == tr_lower(&t)) {
            out.push(t);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stores_and_cleans() {
        let root = std::env::temp_dir().join(format!("gpxer-meta-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let m = MetaStore::open(&root);
        m.set(
            "a",
            FileMeta {
                tags: vec![" iş ".into(), "İş".into(), "".into(), "tatil".into()],
                note: "not".into(),
                activity: Some(Activity::Bike),
            },
        )
        .unwrap();
        let again = MetaStore::open(&root);
        let a = &again.all()["a"];
        assert_eq!(a.tags, vec!["iş", "tatil"]);
        assert_eq!(again.activity("a"), Some(Activity::Bike));
        again.rename("a", "b");
        assert!(again.activity("b").is_some());
        // Boş bilgi kaydı siler.
        again.set("b", FileMeta::default()).unwrap();
        assert!(MetaStore::open(&root).all().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
