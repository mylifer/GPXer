//! Arşivin sağlığı: kütüphanedeki her kaydın içerik parmak izi saklanır;
//! dosya kaybolursa ya da içeriği değişme zamanı değişmeden değişirse (disk
//! hatası, bozulma) bildirilir. Son yedeğin zamanı tutulur; ayarlarda klasör
//! seçiliyse süresi gelince otomatik yedek alınır (son 5 yedek kalır).

use crate::backup::{write_backup, BackupData};
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
/// Son otomatik yedeğin açılıp doğrulanma aralığı.
const VERIFY_EVERY_MS: i64 = 30 * DAY_MS;
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
    last_verify: Option<i64>,
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
    last_verify: Option<i64>,
}

/// Yedek doğrulamasının sonucu: yedek açılıp her kayıt yeniden okunur.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Verify {
    /// Doğrulanan yedek dosyası.
    path: String,
    /// Yedekteki kayıt sayısı.
    records: usize,
    /// Açılıp okunabilen kayıtlar.
    ok: usize,
    /// Bozuk ya da okunamayan kayıtlar (yedekteki adları).
    bad: Vec<String>,
    /// Kütüphanede olup yedekte bulunmayan kayıtlar (dosya adları).
    absent: Vec<String>,
    /// Kayıt bilgileri dosyası okunabildi mi.
    meta_ok: bool,
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
            last_verify: s.last_verify,
        }
    }

    fn note_verify(&self) {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .last_verify = Some(now_ms());
        self.save();
    }
}

/// Yedeği açar, her kaydı açılıp ayrıştırılabiliyor mu diye dener (zip CRC
/// denetimi dahil) ve kütüphanedeki dosyalarla karşılaştırır.
pub(crate) fn verify_backup(path: &Path, library: &[String]) -> Result<Verify, String> {
    use std::io::Read;
    let f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(f).map_err(|e| format!("Yedek açılamadı: {e}"))?;
    let mut v = Verify {
        path: path.to_string_lossy().into_owned(),
        ..Verify::default()
    };
    let mut names = std::collections::HashSet::new();
    for i in 0..zip.len() {
        let mut e = match zip.by_index(i) {
            Ok(e) => e,
            Err(err) => {
                v.bad.push(format!("#{i}: {err}"));
                continue;
            }
        };
        let full = e.name().to_owned();
        let Some(name) = full
            .strip_prefix(crate::backup::RECORDS_DIR)
            .map(str::to_owned)
        else {
            if full == "bilgiler.json" || full.ends_with("/bilgiler.json") {
                let mut b = Vec::new();
                v.meta_ok = e.read_to_end(&mut b).is_ok()
                    && serde_json::from_slice::<serde_json::Value>(&b).is_ok();
            }
            continue;
        };
        if name.is_empty() {
            continue;
        }
        v.records += 1;
        let mut bytes = Vec::new();
        let ext = Path::new(&name)
            .extension()
            .map(|x| x.to_string_lossy().into_owned())
            .unwrap_or_default();
        // read_to_end CRC'yi de denetler; bozuk girdi hata verir.
        let good =
            e.read_to_end(&mut bytes).is_ok() && gpx_core::formats::parse_any(&ext, &bytes).is_ok();
        if good {
            v.ok += 1;
        } else {
            v.bad.push(name.clone());
        }
        names.insert(name);
    }
    v.absent = library
        .iter()
        .filter_map(|f| {
            Path::new(f)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
        })
        .filter(|n| !names.contains(n))
        .collect();
    Ok(v)
}

/// Klasördeki en yeni otomatik yedek.
fn latest_backup(dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with(PREFIX) && n.ends_with(".zip"))
        })
        .max()
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
                &BackupData {
                    files: &app.state::<Library>().files(),
                    meta: &app.state::<MetaStore>().all(),
                    places: &app.state::<PlacesStore>().all(),
                    bookmarks: &app.state::<BookmarkStore>().all(),
                    journal: &app.state::<crate::journal::JournalStore>().all(),
                    attachments: Some(&app.state::<crate::attachments::Attachments>().0),
                },
                None,
            )
        })
        .map(|_| {
            health.note_backup(true);
            prune_backups(&dir);
            dest.to_string_lossy().into_owned()
        })
        .map_err(|e| format!("Otomatik yedek alınamadı ({}): {e}", dir.display()));
    // İkinci kopya (harici disk, bulut klasörü): yarım dosya kalmasın diye
    // önce geçici adla kopyalanıp yerine taşınır.
    if let (Ok(_), Some(dir2)) = (&res, settings.backup_folder2.filter(|d| !d.is_empty())) {
        let dir2 = PathBuf::from(dir2);
        let name = dest.file_name().unwrap_or_default();
        let target = dir2.join(name);
        let tmp = target.with_extension("zip.tmp");
        let copied = std::fs::create_dir_all(&dir2)
            .and_then(|_| std::fs::copy(&dest, &tmp))
            .and_then(|_| std::fs::rename(&tmp, &target));
        if let Err(e) = copied {
            let _ = std::fs::remove_file(&tmp);
            return Some(Err(format!(
                "Yedek alındı ama ikinci klasöre kopyalanamadı ({}): {e}",
                dir2.display()
            )));
        }
        prune_backups(&dir2);
    }
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
        // Ayda bir son otomatik yedek açılıp doğrulanır.
        let verify_due = health
            .info()
            .last_verify
            .is_none_or(|t| now_ms() - t >= VERIFY_EVERY_MS);
        if verify_due {
            if let Some(r) = verify_latest(&app) {
                let _ = app.emit("archive-verify", r);
            }
        }
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

/// Ayarlardaki klasördeki son otomatik yedeği doğrular (klasör ya da yedek
/// yoksa `None`).
fn verify_latest(app: &AppHandle) -> Option<Result<Verify, String>> {
    let dir = PathBuf::from(app.state::<SettingsStore>().current().backup_folder?);
    let path = latest_backup(&dir)?;
    let r = verify_backup(&path, &app.state::<Library>().files());
    app.state::<Health>().note_verify();
    Some(r)
}

/// Son otomatik yedeği şimdi doğrular.
#[tauri::command]
pub(crate) async fn verify_last_backup(app: AppHandle) -> Result<Verify, String> {
    run_blocking(move || {
        verify_latest(&app)
            .unwrap_or_else(|| Err("Yedek klasöründe otomatik yedek yok; önce yedek alın".into()))
    })
    .await?
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
    fn verifies_backup_contents() {
        let dir = std::env::temp_dir().join(format!("gpxer-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gpx = |lat: &str| {
            format!(
                r#"<gpx><trk><trkseg><trkpt lat="{lat}" lon="29"><time>2024-05-01T08:00:00Z</time></trkpt><trkpt lat="{lat}1" lon="29.01"><time>2024-05-01T08:01:00Z</time></trkpt></trkseg></trk></gpx>"#
            )
        };
        let a = dir.join("a.gpx");
        let b = dir.join("b.gpx");
        std::fs::write(&a, gpx("41.0")).unwrap();
        std::fs::write(&b, b"bozuk icerik").unwrap();
        let dest = dir.join(format!("{PREFIX}2025-01-01.zip"));
        let files = vec![
            a.to_string_lossy().into_owned(),
            b.to_string_lossy().into_owned(),
        ];
        write_backup(
            &dest,
            &BackupData {
                files: &files,
                meta: &HashMap::new(),
                places: &[],
                bookmarks: &[],
                journal: &Default::default(),
                attachments: None,
            },
            None,
        )
        .unwrap();
        assert_eq!(latest_backup(&dir), Some(dest.clone()));
        let mut lib = files.clone();
        lib.push(dir.join("c.gpx").to_string_lossy().into_owned());
        let v = verify_backup(&dest, &lib).unwrap();
        assert_eq!((v.records, v.ok), (2, 1));
        assert_eq!(v.bad, vec!["b.gpx".to_owned()]);
        assert_eq!(v.absent, vec!["c.gpx".to_owned()]);
        assert!(verify_backup(&dir.join("yok.zip"), &lib).is_err());
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
