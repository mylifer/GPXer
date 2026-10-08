//! Kalıcı ayarlar ve izlenen klasörler.

use crate::library::is_track_file;
use gpx_core::StatsConfig;
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub stats: StatsConfig,
    /// Yeni GPX dosyaları kendiliğinden kütüphaneye eklenen klasörler.
    pub watched_folders: Vec<String>,
    /// Cihazlar arası eşitleme için bulut klasörü (Drive, iCloud, Dropbox…).
    pub sync_folder: Option<String>,
    /// Otomatik yedeklerin yazıldığı klasör (yoksa otomatik yedek kapalı).
    pub backup_folder: Option<String>,
    /// Otomatik yedek aralığı (gün); 0 ise 7.
    pub backup_days: u32,
}

/// İzlenen klasör: kullanıcının seçtiği yol ve gerçek (kanonik) yolu. macOS
/// FSEvents olayları kanonik yolla gelir (/private/var…, bağlantı hedefi).
#[derive(Clone, Debug)]
struct WatchedFolder {
    raw: PathBuf,
    canonical: Option<PathBuf>,
}

impl WatchedFolder {
    fn new(f: &str) -> Self {
        let raw = PathBuf::from(f);
        let canonical = raw.canonicalize().ok();
        WatchedFolder { raw, canonical }
    }
}

/// Yolun gerçek hali; yol (henüz/artık) yoksa var olan en yakın üst
/// klasörün gerçek hali ile kalan kısım.
fn canonical(path: &Path) -> Option<PathBuf> {
    if let Ok(c) = path.canonicalize() {
        return Some(c);
    }
    let mut rest = Vec::new();
    let mut cur = path;
    while let Some(parent) = cur.parent() {
        rest.push(cur.file_name()?);
        if let Ok(c) = parent.canonicalize() {
            return Some(rest.iter().rev().fold(c, |acc, n| acc.join(n)));
        }
        cur = parent;
    }
    None
}

/// Yol klasörlerden birinin içinde mi; iki taraf da hem verildiği gibi hem
/// kanonik haliyle karşılaştırılır.
fn inside_any(path: &Path, folders: &[WatchedFolder]) -> bool {
    let canon = canonical(path);
    let forms: Vec<&Path> = std::iter::once(path).chain(canon.as_deref()).collect();
    folders.iter().any(|f| {
        forms.iter().any(|p| {
            p.starts_with(&f.raw) || f.canonical.as_ref().is_some_and(|c| p.starts_with(c))
        })
    })
}

fn watched_folders(s: &Settings) -> Vec<WatchedFolder> {
    s.watched_folders
        .iter()
        .map(|f| WatchedFolder::new(f))
        .collect()
}

pub struct SettingsStore {
    path: PathBuf,
    pub current: Mutex<Settings>,
    /// `current.watched_folders`'ın kanonik halleriyle birlikte kopyası.
    watched: Mutex<Vec<WatchedFolder>>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    /// Dosya açılışta okunamadıysa kayıt reddedilir (bkz. [`crate::store`]).
    locked: Option<String>,
}

impl SettingsStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("settings.json");
        let loaded = crate::store::load_json(&path, "Ayar dosyası");
        let current: Settings = loaded.value;
        SettingsStore {
            locked: loaded.locked,
            path,
            watched: Mutex::new(watched_folders(&current)),
            current: Mutex::new(current),
            watcher: Mutex::new(None),
        }
    }

    /// Geçerli ayarların kopyası.
    pub fn current(&self) -> Settings {
        self.current.lock().unwrap().clone()
    }

    pub fn stats(&self) -> StatsConfig {
        self.current.lock().unwrap().stats
    }

    pub fn save(&self, s: Settings) -> std::io::Result<()> {
        if let Some(why) = &self.locked {
            return Err(std::io::Error::other(why.clone()));
        }
        let bytes = serde_json::to_vec_pretty(&s).map_err(std::io::Error::other)?;
        crate::store::write_atomic(&self.path, &bytes)?;
        *self.watched.lock().unwrap() = watched_folders(&s);
        *self.current.lock().unwrap() = s;
        Ok(())
    }

    /// İzlenen klasörler için dosya sistemi izleyicisini (yeniden) kurar.
    /// Klasörde oluşan ya da değişen .gpx dosyaları `on_files` ile bildirilir.
    /// Kurulamayan klasörlerin hata mesajları döndürülür.
    pub fn restart_watcher(&self, on_files: impl Fn(Vec<String>) + Send + 'static) -> Vec<String> {
        // Liste kilit alındıktan sonra okunur: eşzamanlı iki kurulumdan
        // sonra biten de en son kaydedilen listeyi izler.
        let mut slot = self.watcher.lock().unwrap();
        let folders = self.current.lock().unwrap().watched_folders.clone();
        let watched = self.watched.lock().unwrap().clone();
        *slot = None;
        if folders.is_empty() {
            return Vec::new();
        }
        // Senkronizasyon araçları dosyayı parça parça yazabilir; birkaç saniye
        // sessizlik beklenir.
        let debouncer = new_debouncer(Duration::from_secs(3), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<String> = events
                .into_iter()
                .map(|e| e.path)
                // Olay yolları kanonik gelebilir (macOS); izlenen klasör
                // dışındakiler atlanır.
                .filter(|p| p.is_file() && is_track_file(p) && inside_any(p, &watched))
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                on_files(paths);
            }
        });
        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(e) => return vec![format!("Klasör izleme başlatılamadı: {e}")],
        };
        let mut errors = Vec::new();
        for f in &folders {
            if let Err(e) = debouncer
                .watcher()
                .watch(Path::new(f), RecursiveMode::Recursive)
            {
                errors.push(format!("{f} izlenemiyor: {e}"));
            }
        }
        *slot = Some(debouncer);
        errors
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watched_matches_canonical_paths() {
        let root = std::env::temp_dir().join(format!("gpxer-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("gercek");
        std::fs::create_dir_all(real.join("alt")).unwrap();
        std::fs::write(real.join("alt").join("a.gpx"), "x").unwrap();
        // Klasör bağlantı üzerinden seçilmiş; olaylar gerçek yolla gelir.
        let link = root.join("baglanti");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(not(unix))]
        let link = real.clone();
        let folders = vec![WatchedFolder::new(&link.to_string_lossy())];
        let canon = real.canonicalize().unwrap();
        assert!(inside_any(&canon.join("alt").join("a.gpx"), &folders));
        assert!(inside_any(&link.join("alt").join("a.gpx"), &folders));
        // Henüz olmayan dosya da üst klasörüyle eşleşir.
        assert!(inside_any(&canon.join("yeni").join("b.gpx"), &folders));
        assert!(!inside_any(&root.join("dis.gpx"), &folders));
        let _ = std::fs::remove_dir_all(&root);
    }
}
