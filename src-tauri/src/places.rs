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
}

/// `places.json`'u okur. Dosya bozuksa silinmez ve üzerine yazılmaz:
/// `places.json.bad-<zaman>` adıyla kenara alınır, liste boş başlar.
fn load(path: &Path) -> Vec<NamedPlace> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            eprintln!("Yerler dosyası okunamadı ({}): {e}", path.display());
            return Vec::new();
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(list) => list,
        Err(e) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis());
            let mut name = path.file_name().unwrap_or_default().to_os_string();
            name.push(format!(".bad-{stamp}"));
            let bad = path.with_file_name(name);
            match std::fs::rename(path, &bad) {
                Ok(()) => eprintln!(
                    "Yerler dosyası bozuk ({e}); {} olarak saklandı",
                    bad.display()
                ),
                Err(re) => eprintln!("Yerler dosyası bozuk ({e}) ve kenara alınamadı: {re}"),
            }
            Vec::new()
        }
    }
}

pub struct PlacesStore {
    path: PathBuf,
    list: Mutex<Vec<NamedPlace>>,
}

impl PlacesStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("places.json");
        let list = load(&path);
        PlacesStore {
            path,
            list: Mutex::new(list),
        }
    }

    pub fn all(&self) -> Vec<NamedPlace> {
        self.list.lock().unwrap().clone()
    }

    /// Listenin tamamını değiştirir. Yarım dosya kalmasın diye önce geçici
    /// dosyaya yazılır.
    pub fn set(&self, places: Vec<NamedPlace>) -> std::io::Result<()> {
        let mut list = self.list.lock().unwrap();
        let bytes = serde_json::to_vec_pretty(&places).map_err(std::io::Error::other)?;
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(&tmp, &self.path)?;
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
