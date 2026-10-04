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
    /// Dosya açılışta okunamadıysa kayıt reddedilir (bkz. [`crate::store`]).
    locked: Option<String>,
}

impl MetaStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("meta.json");
        let loaded = crate::store::load_json(&path, "Kayıt bilgileri dosyası");
        MetaStore {
            path,
            map: Mutex::new(loaded.value),
            locked: loaded.locked,
        }
    }

    pub fn all(&self) -> HashMap<String, FileMeta> {
        self.map.lock().unwrap().clone()
    }

    pub fn activity(&self, path: &str) -> Option<Activity> {
        self.map.lock().unwrap().get(path).and_then(|m| m.activity)
    }

    fn save(&self, map: &HashMap<String, FileMeta>) -> std::io::Result<()> {
        if let Some(why) = &self.locked {
            return Err(std::io::Error::other(why.clone()));
        }
        let bytes = serde_json::to_vec_pretty(map).map_err(std::io::Error::other)?;
        crate::store::write_atomic(&self.path, &bytes)
    }

    /// Kaydın bilgilerini değiştirir; önceki halini döndürür.
    pub fn set(&self, path: &str, mut meta: FileMeta) -> std::io::Result<FileMeta> {
        meta.tags = clean_tags(meta.tags);
        let mut map = self.map.lock().unwrap();
        // Kaydedilemezse bellekteki bilgi de değişmez (yeniden başlatınca
        // kaybolacak bir değişiklik gösterilmez).
        let mut next = map.clone();
        let old = if meta.is_empty() {
            next.remove(path)
        } else {
            next.insert(path.to_owned(), meta)
        }
        .unwrap_or_default();
        self.save(&next)?;
        *map = next;
        Ok(old)
    }

    /// Kayıtlara etiket ekler; dosya bir kez yazılır. Değişen kayıtların
    /// yeni bilgilerini döndürür.
    pub fn add_tag(
        &self,
        paths: &[String],
        tag: &str,
    ) -> std::io::Result<HashMap<String, FileMeta>> {
        let mut map = self.map.lock().unwrap();
        let mut next = map.clone();
        let mut changed = HashMap::new();
        for p in paths {
            let mut m = next.get(p).cloned().unwrap_or_default();
            let before = m.tags.len();
            m.tags.push(tag.to_owned());
            m.tags = clean_tags(m.tags);
            if m.tags.len() != before {
                next.insert(p.clone(), m.clone());
                changed.insert(p.clone(), m);
            }
        }
        if !changed.is_empty() {
            self.save(&next)?;
            *map = next;
        }
        Ok(changed)
    }

    /// Yedekten gelen bilgileri birleştirir (dosya bir kez yazılır): etiketler
    /// eklenir, boş not ve seçilmemiş tür doldurulur; mevcut bilgi silinmez.
    /// Değişen kayıt sayısını döndürür.
    pub fn merge_many(&self, items: Vec<(String, FileMeta)>) -> std::io::Result<usize> {
        let mut map = self.map.lock().unwrap();
        let mut next = map.clone();
        let mut changed = 0;
        for (path, add) in items {
            let mut m = next.get(&path).cloned().unwrap_or_default();
            let before = m.clone();
            m.tags.extend(add.tags);
            m.tags = clean_tags(m.tags);
            if m.note.trim().is_empty() {
                m.note = add.note;
            }
            if m.activity.is_none() {
                m.activity = add.activity;
            }
            if m != before && !m.is_empty() {
                next.insert(path, m);
                changed += 1;
            }
        }
        if changed > 0 {
            self.save(&next)?;
            *map = next;
        }
        Ok(changed)
    }

    pub fn get(&self, path: &str) -> FileMeta {
        self.map
            .lock()
            .unwrap()
            .get(path)
            .cloned()
            .unwrap_or_default()
    }

    /// Dosya yeni bir ada taşındığında (çöp kutusuna giderken ya da geri
    /// gelirken) bilgileri taşır. `to`daki eski bilgi silinir.
    pub fn rename(&self, from: &str, to: &str) {
        let mut map = self.map.lock().unwrap();
        let old = map.remove(to);
        match map.remove(from) {
            Some(m) => {
                map.insert(to.to_owned(), m);
            }
            None if old.is_none() => return,
            None => {}
        }
        if let Err(e) = self.save(&map) {
            eprintln!("Kayıt bilgileri yazılamadı: {e}");
        }
    }

    /// `dir` içinde olup artık var olmayan dosyaların (kalıcı silinen çöp
    /// kutusu dosyaları) bilgilerini atar.
    pub fn prune(&self, dir: &Path) {
        let mut map = self.map.lock().unwrap();
        let before = map.len();
        map.retain(|k, _| {
            let p = Path::new(k);
            p.parent() != Some(dir) || p.exists()
        });
        if map.len() != before {
            if let Err(e) = self.save(&map) {
                eprintln!("Kayıt bilgileri yazılamadı: {e}");
            }
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
        assert!(again.activity("a").is_none());
        // Kalıcı silinen çöp dosyasının bilgisi atılır.
        let trash = root.join(".trash");
        let gone = trash.join("1-x.gpx").to_string_lossy().into_owned();
        again.rename("b", &gone);
        again.prune(&trash);
        assert!(again.all().is_empty());
        again.rename(&gone, "b");
        assert!(again.all().is_empty());
        again
            .set(
                "b",
                FileMeta {
                    activity: Some(Activity::Bike),
                    ..FileMeta::default()
                },
            )
            .unwrap();
        // Boş bilgi kaydı siler.
        again.set("b", FileMeta::default()).unwrap();
        assert!(MetaStore::open(&root).all().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn failed_save_leaves_memory_unchanged() {
        let root = std::env::temp_dir().join(format!("gpxer-meta-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let m = MetaStore::open(&root);
        // meta.json yerine klasör: üzerine taşıma başarısız olur.
        std::fs::create_dir(root.join("meta.json")).unwrap();
        std::fs::write(root.join("meta.json").join("x"), "x").unwrap();
        let r = m.set(
            "a",
            FileMeta {
                note: "not".into(),
                ..Default::default()
            },
        );
        assert!(r.is_err());
        assert!(m.all().is_empty());
    }

    #[test]
    fn adds_tag_to_many_in_one_write() {
        let root = std::env::temp_dir().join(format!("gpxer-meta-many-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let m = MetaStore::open(&root);
        m.set(
            "a",
            FileMeta {
                tags: vec!["İş".into()],
                ..Default::default()
            },
        )
        .unwrap();
        let changed = m.add_tag(&["a".into(), "b".into()], "iş").unwrap();
        // "a" zaten etiketli (büyük/küçük harf Türkçe kurallarıyla).
        assert_eq!(changed.keys().collect::<Vec<_>>(), vec!["b"]);
        let again = MetaStore::open(&root);
        assert_eq!(again.get("b").tags, vec!["iş"]);
        assert_eq!(again.get("a").tags, vec!["İş"]);
    }

    #[test]
    fn merge_keeps_existing_and_adds_missing() {
        let root = std::env::temp_dir().join(format!("gpxer-meta-merge-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let m = MetaStore::open(&root);
        m.set(
            "a",
            FileMeta {
                tags: vec!["iş".into()],
                note: "benim notum".into(),
                activity: None,
            },
        )
        .unwrap();
        let n = m
            .merge_many(vec![
                (
                    "a".into(),
                    FileMeta {
                        tags: vec!["İŞ".into(), "tatil".into()],
                        note: "yedekteki not".into(),
                        activity: Some(Activity::Walk),
                    },
                ),
                (
                    "b".into(),
                    FileMeta {
                        note: "yeni".into(),
                        ..Default::default()
                    },
                ),
            ])
            .unwrap();
        assert_eq!(n, 2);
        let a = m.get("a");
        assert_eq!(a.tags, vec!["iş", "tatil"]);
        assert_eq!(a.note, "benim notum");
        assert_eq!(a.activity, Some(Activity::Walk));
        assert_eq!(MetaStore::open(&root).get("b").note, "yeni");
    }
}
