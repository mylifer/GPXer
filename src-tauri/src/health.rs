//! Arşivin sağlığı: kütüphanedeki her kaydın içerik parmak izi saklanır;
//! dosya kaybolursa ya da içeriği değişme zamanı değişmeden değişirse (disk
//! hatası, bozulma) bildirilir. Son yedeğin zamanı tutulur; ayarlarda klasör
//! seçiliyse süresi gelince otomatik yedek alınır (son 5 yedek kalır).

use crate::backup::write_backup;
use crate::bookmarks::BookmarkStore;
use crate::library::Library;
use crate::meta::MetaStore;
use crate::places::PlacesStore;
use crate::run_blocking;
use crate::settings::SettingsStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const DAY_MS: i64 = 86_400_000;
/// Otomatik denetim aralığı.
const CHECK_EVERY_MS: i64 = 7 * DAY_MS;
/// Klasörde tutulan otomatik yedek sayısı.
const KEEP: usize = 5;
const PREFIX: &str = "GPXer-otomatik-yedek-";

/// Dosya: (boyut, değişme zamanı sn, içerik özeti).
type Print = (u64, u64, String);

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct State {
    prints: HashMap<String, Print>,
    last_backup: Option<i64>,
    last_auto_backup: Option<i64>,
    last_check: Option<i64>,
}

pub(crate) struct Health {
    path: PathBuf,
    state: Mutex<State>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    total: usize,
    ok: usize,
    /// Diskte bulunamayan kayıtlar.
    missing: Vec<String>,
    /// İçeriği değişme zamanı değişmeden değişmiş (bozulmuş olabilir).
    corrupted: Vec<String>,
    /// Okunamayan kayıtlar.
    unreadable: Vec<String>,
    checked_at: i64,
    last_backup: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    last_backup: Option<i64>,
    last_auto_backup: Option<i64>,
    last_check: Option<i64>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Kararlı 64 bit özet (FNV-1a).
fn digest(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

/// Unix gününden yyyy-aa-gg (Howard Hinnant'ın takvim algoritması).
pub(crate) fn ymd(ms: i64) -> String {
    let z = ms.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

impl Health {
    pub(crate) fn open(root: &Path) -> Self {
        let path = root.join("arsiv-sagligi.json");
        let state = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Health {
            path,
            state: Mutex::new(state),
        }
    }

    fn save(&self) {
        let bytes = {
            let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            serde_json::to_vec(&*s).ok()
        };
        if let Some(b) = bytes {
            let _ = crate::store::write_atomic(&self.path, &b);
        }
    }

    pub(crate) fn note_backup(&self, auto: bool) {
        {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let t = now_ms();
            s.last_backup = Some(t);
            if auto {
                s.last_auto_backup = Some(t);
            }
        }
        self.save();
    }

    /// Kayıtları denetler; yeni ya da bilerek değiştirilmiş dosyaların izi güncellenir.
    pub(crate) fn check(&self, files: &[String]) -> Report {
        let mut r = Report {
            total: files.len(),
            checked_at: now_ms(),
            ..Report::default()
        };
        let mut fresh: HashMap<String, Print> = HashMap::new();
        let old = std::mem::take(&mut self.state.lock().unwrap_or_else(|e| e.into_inner()).prints);
        for f in files {
            let Ok(m) = std::fs::metadata(f) else {
                r.missing.push(f.clone());
                if let Some(p) = old.get(f) {
                    fresh.insert(f.clone(), p.clone());
                }
                continue;
            };
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            let Ok(bytes) = std::fs::read(f) else {
                r.unreadable.push(f.clone());
                continue;
            };
            let h = digest(&bytes);
            match old.get(f) {
                // Boyut ve zaman aynı, içerik farklı: bozulma. Eski iz saklanır
                // (sonraki denetimde de bildirilsin).
                Some((size, t, prev)) if *size == m.len() && *t == mtime && *prev != h => {
                    r.corrupted.push(f.clone());
                    fresh.insert(f.clone(), (*size, *t, prev.clone()));
                }
                _ => {
                    r.ok += 1;
                    fresh.insert(f.clone(), (m.len(), mtime, h));
                }
            }
        }
        {
            let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
            s.prints = fresh;
            s.last_check = Some(r.checked_at);
            r.last_backup = s.last_backup;
        }
        self.save();
        r
    }

    fn info(&self) -> Info {
        let s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        Info {
            last_backup: s.last_backup,
            last_auto_backup: s.last_auto_backup,
            last_check: s.last_check,
        }
    }
}

/// Klasördeki eski otomatik yedekler silinir (en yeni `KEEP` tanesi kalır).
fn prune_backups(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut list: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(".zip"))
        })
        .collect();
    // Ad tarih içerdiği için ad sırası zaman sırasıdır.
    list.sort();
    let n = list.len();
    for p in list.into_iter().take(n.saturating_sub(KEEP)) {
        let _ = std::fs::remove_file(p);
    }
}

/// Otomatik yedek: klasör seçiliyse ve süresi geldiyse alınır.
fn auto_backup(app: &AppHandle, force: bool) -> Option<Result<String, String>> {
    let settings = app.state::<SettingsStore>().current();
    let dir = PathBuf::from(settings.backup_folder?);
    let days = if settings.backup_days == 0 {
        7
    } else {
        settings.backup_days
    } as i64;
    let health = app.state::<Health>();
    let last = health.info().last_auto_backup.unwrap_or(0);
    if !force && now_ms() - last < days * DAY_MS {
        return None;
    }
    let dest = dir.join(format!("{PREFIX}{}.zip", ymd(now_ms())));
    let res = std::fs::create_dir_all(&dir)
        .and_then(|_| {
            write_backup(
                &dest,
                &app.state::<Library>().files(),
                &app.state::<MetaStore>().all(),
                &app.state::<PlacesStore>().all(),
                &app.state::<BookmarkStore>().all(),
                &app.state::<crate::journal::JournalStore>().all(),
                None,
            )
        })
        .map(|_| {
            health.note_backup(true);
            prune_backups(&dir);
            dest.to_string_lossy().into_owned()
        })
        .map_err(|e| format!("Otomatik yedek alınamadı ({}): {e}", dir.display()));
    Some(res)
}

/// Açılışta (arka planda): süresi geldiyse otomatik yedek ve haftalık denetim.
/// Sonuçlar arayüze olay olarak bildirilir.
pub(crate) fn on_startup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Açılış yükü geçsin.
        std::thread::sleep(std::time::Duration::from_secs(20));
        if let Some(r) = auto_backup(&app, false) {
            let _ = app.emit("archive-backup", r.map_err(|e| e.to_string()));
        }
        let health = app.state::<Health>();
        let due = health
            .info()
            .last_check
            .is_none_or(|t| now_ms() - t >= CHECK_EVERY_MS);
        if due {
            let report = health.check(&app.state::<Library>().files());
            let _ = app.emit("archive-health", report);
        }
    });
}

#[tauri::command]
pub(crate) async fn archive_check(app: AppHandle) -> Result<Report, String> {
    run_blocking(move || app.state::<Health>().check(&app.state::<Library>().files())).await
}

#[tauri::command]
pub(crate) fn archive_info(health: tauri::State<'_, Health>) -> Info {
    health.info()
}

/// Otomatik yedeği şimdi alır (ayarlardaki klasöre).
#[tauri::command]
pub(crate) async fn backup_now(app: AppHandle) -> Result<String, String> {
    run_blocking(move || {
        auto_backup(&app, true).unwrap_or_else(|| Err("Önce Ayarlar'da yedek klasörü seçin".into()))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(ymd(0), "1970-01-01");
        assert_eq!(ymd(1_709_164_800_000), "2024-02-29");
        assert_eq!(ymd(1_759_881_600_000), "2025-10-08");
    }

    #[test]
    fn detects_missing_and_corrupted_files() {
        let dir = std::env::temp_dir().join(format!("gpxer-health-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.gpx");
        let b = dir.join("b.gpx");
        std::fs::write(&a, b"<gpx>aaaa</gpx>").unwrap();
        std::fs::write(&b, b"<gpx>bbbb</gpx>").unwrap();
        let files = vec![
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ];
        let h = Health::open(&dir);
        let r = h.check(&files);
        assert_eq!((r.ok, r.missing.len(), r.corrupted.len()), (2, 0, 0));
        // Aynı boyutta içerik değişir, değişme zamanı geri alınır: bozulma.
        let t = std::fs::metadata(&a).unwrap().modified().unwrap();
        std::fs::write(&a, b"<gpx>aaXa</gpx>").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&a)
            .unwrap()
            .set_modified(t)
            .unwrap();
        std::fs::remove_file(&b).unwrap();
        let r = Health::open(&dir).check(&files);
        assert_eq!(r.corrupted, vec![files[0].clone()]);
        assert_eq!(r.missing, vec![files[1].clone()]);
        // Bilerek düzenlenen dosya (zaman değişir) bozulma sayılmaz.
        std::fs::write(&a, b"<gpx>yeni icerik</gpx>").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&a)
            .unwrap()
            .set_modified(t + std::time::Duration::from_secs(60))
            .unwrap();
        let r = Health::open(&dir).check(&files);
        assert!(r.corrupted.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn keeps_last_backups() {
        let dir = std::env::temp_dir().join(format!("gpxer-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for d in 1..=7 {
            std::fs::write(dir.join(format!("{PREFIX}2025-01-0{d}.zip")), b"x").unwrap();
        }
        std::fs::write(dir.join("baska.zip"), b"x").unwrap();
        prune_backups(&dir);
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left.len(), 6);
        assert!(left.contains(&"baska.zip".to_owned()));
        assert!(!left
            .iter()
            .any(|n| n.ends_with("01-01.zip") || n.ends_with("01-02.zip")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
