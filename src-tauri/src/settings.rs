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
}

pub struct SettingsStore {
    path: PathBuf,
    pub current: Mutex<Settings>,
    watcher: Mutex<Option<Debouncer<RecommendedWatcher>>>,
}

impl SettingsStore {
    pub fn open(root: &Path) -> Self {
        let path = root.join("settings.json");
        let current = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        SettingsStore {
            path,
            current: Mutex::new(current),
            watcher: Mutex::new(None),
        }
    }

    pub fn stats(&self) -> StatsConfig {
        self.current.lock().unwrap().stats
    }

    pub fn save(&self, s: Settings) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(&s).map_err(std::io::Error::other)?;
        std::fs::write(&self.path, bytes)?;
        *self.current.lock().unwrap() = s;
        Ok(())
    }

    /// İzlenen klasörler için dosya sistemi izleyicisini (yeniden) kurar.
    /// Klasörde oluşan ya da değişen .gpx dosyaları `on_files` ile bildirilir.
    /// Kurulamayan klasörlerin hata mesajları döndürülür.
    pub fn restart_watcher(&self, on_files: impl Fn(Vec<String>) + Send + 'static) -> Vec<String> {
        let folders = self.current.lock().unwrap().watched_folders.clone();
        let mut slot = self.watcher.lock().unwrap();
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
                .filter(|p| p.is_file() && is_track_file(p))
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
