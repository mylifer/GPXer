//! Kullanıcının adlandırdığı yerler (ev, iş…): `places.json` dosyasında
//! tutulur. Adlar arayüzde uygulanır; özetler değişmez.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NamedPlace {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    /// Yerin yarıçapı (m).
    pub radius_m: f64,
    /// Gizlilik bölgesi: dışa aktarma ve paylaşımlarda çevresi kırpılır.
    #[serde(default)]
    pub private: bool,
}

/// Gizlilik bölgeleri `(enlem, boylam, yarıçap)`; en az 300 m.
pub fn privacy_zones(places: &[NamedPlace]) -> Vec<(f64, f64, f64)> {
    places
        .iter()
        .filter(|p| p.private)
        .map(|p| (p.lat, p.lon, p.radius_m.max(300.0)))
        .collect()
}

pub struct PlacesStore {
    path: PathBuf,
    list: Mutex<Vec<NamedPlace>>,
    /// Dosya açılışta okunamadıysa kayıt reddedilir (bkz. [`crate::store`]).
    locked: Option<String>,
}

impl PlacesStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("places.json");
        let loaded = crate::store::load_json(&path, "Yerler dosyası");
        PlacesStore {
            path,
            list: Mutex::new(loaded.value),
            locked: loaded.locked,
        }
    }

    pub fn all(&self) -> Vec<NamedPlace> {
        self.list.lock().unwrap().clone()
    }

    /// Listenin tamamını değiştirir. Yarım dosya kalmasın diye önce geçici
    /// dosyaya yazılır.
    pub fn set(&self, places: Vec<NamedPlace>) -> std::io::Result<()> {
        if let Some(why) = &self.locked {
            return Err(std::io::Error::other(why.clone()));
        }
        let mut list = self.list.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(&places).map_err(std::io::Error::other)?;
        crate::store::write_atomic(&self.path, &bytes)?;
        *list = places;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn places_round_trip() {
        let root = std::env::temp_dir().join(format!("gpxer-places-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let store = PlacesStore::open(&root);
        assert!(store.all().is_empty());
        let home = NamedPlace {
            id: "a1".into(),
            name: "Ev".into(),
            lat: 41.06,
            lon: 28.98,
            radius_m: 150.0,
            private: false,
        };
        store.set(vec![home.clone()]).unwrap();
        assert_eq!(store.all(), vec![home.clone()]);
        // Yeniden açılınca diskten okunur; alan adları camelCase.
        assert_eq!(PlacesStore::open(&root).all(), vec![home]);
        let text = std::fs::read_to_string(root.join("places.json")).unwrap();
        assert!(text.contains("\"radiusM\""), "{text}");
        assert!(!root.join("places.tmp").exists());
        store.set(Vec::new()).unwrap();
        assert!(PlacesStore::open(&root).all().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn corrupt_file_is_kept_aside() {
        let root = std::env::temp_dir().join(format!("gpxer-places-bad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("places.json"), b"{bozuk").unwrap();
        let store = PlacesStore::open(&root);
        assert!(store.all().is_empty());
        let bad: Vec<PathBuf> = std::fs::read_dir(&root)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("places.json.bad-")
            })
            .collect();
        assert_eq!(bad.len(), 1);
        assert_eq!(std::fs::read(&bad[0]).unwrap(), b"{bozuk");
        assert!(!root.join("places.json").exists());
        // Yeni kayıt bozuk dosyanın kopyasını ezmez.
        store.set(Vec::new()).unwrap();
        assert_eq!(std::fs::read(&bad[0]).unwrap(), b"{bozuk");
        let _ = std::fs::remove_dir_all(&root);
    }
}
