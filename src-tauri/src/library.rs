//! Kütüphane: açılan dosyaların uygulama klasöründeki kopyaları, özet
//! önbelleği ve silinen dosyalar için çöp kutusu.

use crate::geo::{place_at, time_zone_at, untimed_visits, visits};
use gpx_core::{Activity, FileSummary, Prepared, StatsConfig};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

/// Önbellek biçimi ya da özet hesaplaması değiştiğinde artırılır; eski
/// önbellek yok sayılır.
const CACHE_VERSION: u32 = 22;
/// Bellekte tutulan hazırlanmış (temizlenmiş) kayıt sayısı.
const PREPARED_KEEP: usize = 4;
/// Çöp kutusundaki dosyalar bu süreden sonra kalıcı olarak silinir.
const TRASH_KEEP_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LoadResult {
    Ok {
        file: Box<FileSummary>,
    },
    Error {
        path: String,
        message: String,
    },
    /// İçeriği kütüphanedeki `existing` dosyasıyla aynı.
    Duplicate {
        path: String,
        existing: String,
    },
    /// Dosyada hiç nokta yok (ör. başlatılıp hemen durdurulmuş kayıt);
    /// hata değil, atlanır.
    Empty {
        path: String,
    },
}

/// Özet çıkarılamama nedeni.
#[derive(Debug)]
pub enum SummaryError {
    /// Dosyada rota, iz ya da nokta yok.
    Empty,
    Failed(String),
}

impl std::fmt::Display for SummaryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SummaryError::Empty => gpx_core::LoadError::Empty.fmt(f),
            SummaryError::Failed(m) => f.write_str(m),
        }
    }
}

impl From<gpx_core::LoadError> for SummaryError {
    fn from(e: gpx_core::LoadError) -> Self {
        match e {
            gpx_core::LoadError::Empty => SummaryError::Empty,
            other => SummaryError::Failed(other.to_string()),
        }
    }
}

impl SummaryError {
    /// Yükleme sonucu: boş dosya hata sayılmaz.
    pub fn into_result(self, path: String) -> LoadResult {
        match self {
            SummaryError::Empty => LoadResult::Empty { path },
            SummaryError::Failed(message) => LoadResult::Error { path, message },
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    /// Kütüphanedeki eski yolu.
    pub original: String,
    /// Çöp kutusundaki yolu.
    pub trashed: String,
}

#[derive(Serialize, Deserialize)]
struct CacheEntry {
    size: u64,
    mtime: i64,
    cfg: StatsConfig,
    /// Kullanıcının seçtiği etkinlik türü (özet buna göre hesaplandı).
    #[serde(default)]
    chosen: Option<Activity>,
    fingerprint: u64,
    summary: FileSummary,
}

/// Kütüphane dışındaki (izlenen klasör, İndirilenler…) bir dosya için
/// yalnızca kopya tespitine yetecek bilgi: tam özet saklanmaz (önbellek her
/// dışarıdan açılan dosya için ikiye katlanıyordu).
#[derive(Serialize, Deserialize, Clone, Copy)]
struct SeenEntry {
    size: u64,
    mtime: i64,
    fingerprint: u64,
}

/// Eski biçim (tek JSON dosyası): yalnızca bir kez okunup günlüğe aktarılır.
#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, CacheEntry>,
    #[serde(default)]
    seen: HashMap<String, SeenEntry>,
}

/// Önbellek günlüğünün bir satırı (okurken). Düz yapı: etiketli bir enum
/// serde'yi satırı ara belleğe almaya zorlayıp okumayı iki kat yavaşlatıyordu.
#[derive(Deserialize)]
struct LogLine {
    v: u32,
    p: String,
    /// Kütüphanedeki kaydın özeti.
    #[serde(default)]
    e: Option<Box<CacheEntry>>,
    /// Kütüphane dışındaki dosyanın kopya bilgisi.
    #[serde(default)]
    s: Option<SeenEntry>,
    /// Silindi (sürümden bağımsız uygulanır).
    #[serde(default)]
    d: bool,
}

/// Önbellek günlüğünün bir satırı (yazarken; kopyalamadan).
#[derive(Serialize)]
struct LogLineRef<'a> {
    v: u32,
    p: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    e: Option<&'a CacheEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    s: Option<&'a SeenEntry>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    d: bool,
}

impl<'a> LogLineRef<'a> {
    fn entry(p: &'a str, e: &'a CacheEntry) -> Self {
        Self {
            v: CACHE_VERSION,
            p,
            e: Some(e),
            s: None,
            d: false,
        }
    }
    fn seen(p: &'a str, s: &'a SeenEntry) -> Self {
        Self {
            v: CACHE_VERSION,
            p,
            e: None,
            s: Some(s),
            d: false,
        }
    }
    fn del(p: &'a str) -> Self {
        Self {
            v: CACHE_VERSION,
            p,
            e: None,
            s: None,
            d: true,
        }
    }
}

/// Özet önbelleği. Diskte yalnızca eklenen bir günlük (JSON satırları):
/// her değişiklikte yalnızca değişen kayıtlar dosyanın sonuna yazılır (tek
/// dosyayı her seferinde baştan yazmak on bin kayıtta 100 MB demekti). Günlük
/// canlı verinin iki katını aşınca sıkıştırılır.
#[derive(Default)]
struct Cache {
    entries: HashMap<String, CacheEntry>,
    seen: HashMap<String, SeenEntry>,
    /// Son yazımdan beri değişen (eklenen, güncellenen, silinen) yollar.
    changed: HashSet<String>,
    /// Bir sonraki yazımda günlük baştan (sıkıştırılmış) yazılsın.
    full: bool,
    /// Günlükteki satır sayısı.
    log_lines: usize,
}

/// Günlüğü okur: satırlar sırayla uygulanır; sürümü farklı ya da yarım kalmış
/// (çökme) satırlar atlanır.
fn replay_log(
    bytes: &[u8],
) -> (
    HashMap<String, CacheEntry>,
    HashMap<String, SeenEntry>,
    usize,
) {
    use rayon::prelude::*;
    let lines: Vec<&[u8]> = bytes
        .split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .collect();
    // Ayrıştırma paralel, uygulama sırayla (sonraki satır öncekini ezer).
    let parsed: Vec<Option<LogLine>> = lines
        .par_iter()
        .map(|l| serde_json::from_slice(l).ok())
        .collect();
    let (mut entries, mut seen) = (HashMap::new(), HashMap::new());
    for line in parsed.into_iter().flatten() {
        if line.d {
            entries.remove(&line.p);
            seen.remove(&line.p);
        } else if line.v != CACHE_VERSION {
            continue;
        } else if let Some(e) = line.e {
            seen.remove(&line.p);
            entries.insert(line.p, *e);
        } else if let Some(s) = line.s {
            entries.remove(&line.p);
            seen.insert(line.p, s);
        }
    }
    (entries, seen, lines.len())
}

/// Hazırlanmış kaydın anahtarı: dosya değişince ya da ayarlar değişince geçersiz.
#[derive(PartialEq)]
struct PreparedKey {
    path: String,
    size: u64,
    mtime: i64,
    cfg: StatsConfig,
}

pub struct Library {
    pub dir: PathBuf,
    pub trash_dir: PathBuf,
    cache_path: PathBuf,
    /// Eski tek dosyalık önbellek (aktarıldıktan sonra silinir).
    legacy_cache_path: PathBuf,
    /// Önbellek yazımları sırayla (günlükte eski değer yenisinin ardına düşmesin).
    flush_lock: Mutex<()>,
    dismissed_path: PathBuf,
    /// İçerik parmak izi → kütüphanedeki dosya yolu.
    known: Mutex<HashMap<u64, String>>,
    cache: Mutex<Cache>,
    /// Kullanıcının sildiği kayıtların parmak izi → çöp kutusundaki yolları
    /// (aynı içerik birden çok kez silinmiş olabilir). Kendiliğinden
    /// yüklemelerde (izlenen klasör) yeniden eklenmezler.
    dismissed: Mutex<Dismissed>,
    /// Son kullanılan hazırlanmış kayıtlar (grafik, aralık, kırpma için).
    prepared: Mutex<VecDeque<(PreparedKey, Arc<Prepared>)>>,
}

/// Parmak izi → çöp kutusundaki yollar.
type Dismissed = HashMap<u64, BTreeSet<String>>;

/// dismissed.json'u okur. Eski biçim (parmak izi → tek yol) de kabul edilir.
fn parse_dismissed(bytes: &[u8]) -> Option<Dismissed> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Paths {
        Many(BTreeSet<String>),
        One(String),
    }
    let map: HashMap<u64, Paths> = serde_json::from_slice(bytes).ok()?;
    Some(
        map.into_iter()
            .map(|(fp, p)| {
                let set = match p {
                    Paths::Many(s) => s,
                    Paths::One(s) => BTreeSet::from([s]),
                };
                (fp, set)
            })
            .collect(),
    )
}

pub fn is_gpx(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| gpx_core::formats::format_of_ext(&e.to_string_lossy()) == Some("gpx"))
}

/// Açılabilen iz dosyası mı (GPX, FIT, TCX, KML; JSON yalnızca Google konum
/// geçmişi adıyla).
pub fn is_track_file(path: &Path) -> bool {
    path.extension().is_some_and(|e| {
        let ext = e.to_string_lossy();
        match gpx_core::formats::format_of_ext(&ext) {
            Some("json") => path
                .file_name()
                .is_some_and(|n| gpx_core::google::is_google_file_name(&n.to_string_lossy())),
            Some(_) => true,
            None => false,
        }
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// Windows'ta dosya adı olarak kullanılamayan aygıt adları.
fn is_reserved_name(stem: &str) -> bool {
    let base = stem
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((base.starts_with("COM") || base.starts_with("LPT"))
            && base.len() == 4
            && matches!(base.as_bytes()[3], b'1'..=b'9'))
}

/// Dosya adında kullanılamayan karakterleri, Windows'un ayrılmış adlarını ve
/// sondaki nokta/boşlukları temizler.
/// Çöp kutusundaki ad: zaman öneki + ad. Önceki sürümlerin kabul ettiği uzun
/// adlar önekle 255 baytı aşmasın diye kısaltılır (uzantı korunur).
fn trash_name(stamp: i64, name: &str) -> String {
    const MAX: usize = 240;
    let prefix = format!("{stamp}-");
    if prefix.len() + name.len() <= MAX {
        return format!("{prefix}{name}");
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if name.len() - i <= 12 => name.split_at(i),
        _ => (name, ""),
    };
    let mut cut = MAX.saturating_sub(prefix.len() + ext.len()).min(stem.len());
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{prefix}{}{ext}", &stem[..cut])
}

pub fn safe_stem(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    // Dosya adı sınırı 255 bayttır (karakter değil). Sona eklenen " (n)",
    // uzantı ve çöp kutusu öneki ile macOS'un ayrıştırılmış (NFD) Türkçe
    // harfleri (ş: 2 → 3 bayt) için pay bırakılır.
    const MAX_STEM_BYTES: usize = 150;
    let mut s: String = s.trim().trim_matches('.').to_owned();
    if s.len() > MAX_STEM_BYTES {
        let mut cut = MAX_STEM_BYTES;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    let s = s.trim_end_matches(['.', ' ']).trim_start();
    if s.is_empty() {
        "iz".into()
    } else if is_reserved_name(s) {
        format!("_{s}")
    } else {
        s.to_owned()
    }
}

impl Library {
    pub fn open(root: &Path) -> std::io::Result<Self> {
        let dir = root.join("library");
        let trash_dir = dir.join(".trash");
        std::fs::create_dir_all(&trash_dir)?;
        let cache_path = root.join("summary-cache.log");
        let legacy_cache_path = root.join("summary-cache.json");
        let dismissed_path = root.join("dismissed.json");
        let dismissed = std::fs::read(&dismissed_path)
            .ok()
            .and_then(|b| parse_dismissed(&b))
            .unwrap_or_default();
        let (mut entries, mut seen, log_lines, from_legacy) = match std::fs::read(&cache_path) {
            Ok(b) => {
                let (e, s, n) = replay_log(&b);
                (e, s, n, false)
            }
            Err(_) => {
                let file = std::fs::read(&legacy_cache_path)
                    .ok()
                    .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
                    .filter(|c| c.version == CACHE_VERSION)
                    .unwrap_or_default();
                (file.entries, file.seen, 0, true)
            }
        };
        // Eski önbellekteki kütüphane dışı tam özetler hafif kayda dönüşür.
        let outside: Vec<String> = entries
            .keys()
            .filter(|p| Path::new(p).parent() != Some(dir.as_path()))
            .cloned()
            .collect();
        let migrated = !outside.is_empty();
        for p in outside {
            if let Some(e) = entries.remove(&p) {
                seen.insert(
                    p,
                    SeenEntry {
                        size: e.size,
                        mtime: e.mtime,
                        fingerprint: e.fingerprint,
                    },
                );
            }
        }
        let lib = Library {
            dir,
            trash_dir,
            cache_path,
            legacy_cache_path,
            flush_lock: Mutex::default(),
            dismissed_path,
            known: Mutex::default(),
            cache: Mutex::new(Cache {
                entries,
                seen,
                changed: HashSet::new(),
                full: migrated || from_legacy,
                log_lines,
            }),
            dismissed: Mutex::new(dismissed),
            prepared: Mutex::default(),
        };
        lib.purge_trash(now_ms() - TRASH_KEEP_MS);
        Ok(lib)
    }

    pub fn contains(&self, path: &Path) -> bool {
        path.parent() == Some(self.dir.as_path())
            && matches!(
                path.components().next_back(),
                Some(std::path::Component::Normal(_))
            )
    }

    /// Yolun kütüphanedeki bir dosya olduğunu denetler.
    pub fn check(&self, path: &str) -> Result<(), String> {
        if self.contains(Path::new(path)) {
            Ok(())
        } else {
            Err("Yalnızca kütüphanedeki kayıtlar kullanılabilir".into())
        }
    }

    pub fn files(&self) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(&self.dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.is_file() && is_gpx(p))
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        out.sort();
        out
    }

    /// "ad.gpx" ya da doluysa "ad (2).gpx"… adıyla yeni, boş bir dosyayı
    /// oluşturur. `create_new` ile açıldığından aynı anda iki yazma aynı adı
    /// alamaz.
    fn create_unique(&self, stem: &str) -> std::io::Result<(PathBuf, std::fs::File)> {
        for n in 1..10_000 {
            let name = if n == 1 {
                format!("{stem}.gpx")
            } else {
                format!("{stem} ({n}).gpx")
            };
            let target = self.dir.join(name);
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
            {
                Ok(f) => return Ok((target, f)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other("Boş bir dosya adı bulunamadı"))
    }

    /// İçeriği boş bir ada yazar; yazılamazsa yarım dosya bırakmaz.
    fn write_unique(&self, stem: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
        let (target, mut f) = self.create_unique(stem)?;
        if let Err(e) = f.write_all(bytes) {
            drop(f);
            let _ = std::fs::remove_file(&target);
            return Err(e);
        }
        Ok(target)
    }

    /// Kütüphanede aynı adla dosya varsa "ad (2).gpx" gibi boş bir ad bulup
    /// dosyayı oraya kopyalar. GPX dışındaki biçimler GPX'e çevrilerek saklanır.
    fn copy_in(&self, src: &Path) -> std::io::Result<PathBuf> {
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "iz".into());
        let bytes = if is_gpx(src) {
            std::fs::read(src)?
        } else {
            let (gpx, _) = gpx_core::read_gpx_file(src).map_err(std::io::Error::other)?;
            gpx_core::write::write_gpx(&gpx).into_bytes()
        };
        self.write_unique(&safe_stem(&stem), &bytes)
    }

    /// Dosyanın şimdiki halini çöp kutusuna kopyalar (yerinde değiştirmeden
    /// önce; geri almak için). Kopyanın yolunu döner.
    pub fn keep_previous(&self, path: &str) -> Result<String, String> {
        self.check(path)?;
        let p = Path::new(path);
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        let target = self.trash_dir.join(trash_name(now_ms(), &name));
        std::fs::copy(p, &target).map_err(|e| format!("Önceki hali saklanamadı: {e}"))?;
        Ok(target.to_string_lossy().into_owned())
    }

    /// [`keep_previous`] ile saklanan hali geri koyar ve saklanan kopyayı siler.
    pub fn put_back(&self, path: &str, previous: &str) -> Result<(), String> {
        self.check(path)?;
        let prev = Path::new(previous);
        if prev.parent() != Some(self.trash_dir.as_path()) || !prev.is_file() {
            return Err("Önceki hali artık yok".into());
        }
        let bytes = std::fs::read(prev).map_err(|e| e.to_string())?;
        crate::store::write_atomic(Path::new(path), &bytes).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(prev);
        Ok(())
    }

    /// Yeni oluşturulan (kırpılan, birleştirilen…) bir kaydı kütüphaneye yazar.
    pub fn write_new(&self, name: &str, text: &str) -> std::io::Result<PathBuf> {
        self.write_unique(&safe_stem(name), text.as_bytes())
    }

    /// Kütüphanedeki dosyanın hazırlanmış (temizlenmiş) hali. Son kullanılan
    /// birkaç kayıt bellekte tutulur; dosya ya da ayarlar değişince yeniden
    /// hazırlanır.
    pub fn prepared(&self, path: &str, cfg: &StatsConfig) -> Result<Arc<Prepared>, String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
        let key = PreparedKey {
            path: path.to_owned(),
            size: meta.len(),
            mtime: mtime_ms(&meta),
            cfg: *cfg,
        };
        {
            let mut list = self.prepared.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(pos) = list.iter().position(|(k, _)| *k == key) {
                let hit = list.remove(pos).unwrap();
                let p = hit.1.clone();
                list.push_front(hit);
                return Ok(p);
            }
        }
        let (p, _) = gpx_core::read_prepared(Path::new(path), cfg).map_err(|e| e.to_string())?;
        let p = Arc::new(p);
        let mut list = self.prepared.lock().unwrap_or_else(PoisonError::into_inner);
        list.retain(|(k, _)| k.path != key.path);
        list.push_front((key, p.clone()));
        list.truncate(PREPARED_KEEP);
        Ok(p)
    }

    /// Silinen bir kaydın parmak izi mi (izlenen klasörden yeniden eklenmez).
    pub fn is_dismissed(&self, fingerprint: u64) -> bool {
        self.dismissed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains_key(&fingerprint)
    }

    /// Yükleme silinen kayıt yüzünden atlanmalı mı: yalnızca kendiliğinden
    /// (elle açılmamış) ve kütüphane dışından gelen yüklemelerde.
    pub fn blocks(&self, fingerprint: u64, path: &str, explicit: bool) -> bool {
        !explicit && !self.contains(Path::new(path)) && self.is_dismissed(fingerprint)
    }

    /// Kaydı silinenlerden çıkarır (kullanıcı yeniden açtı ya da geri aldı).
    pub fn undismiss(&self, fingerprint: u64) {
        let mut map = self
            .dismissed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if map.remove(&fingerprint).is_some() {
            self.save_dismissed(&map);
        }
    }

    fn save_dismissed(&self, map: &Dismissed) {
        let res = serde_json::to_vec(map)
            .map_err(std::io::Error::other)
            .and_then(|bytes| crate::store::write_atomic(&self.dismissed_path, &bytes));
        if let Err(e) = res {
            eprintln!("Silinen kayıtlar listesi yazılamadı: {e}");
        }
    }

    /// Dosyanın özetini ve parmak izini döndürür. Boyutu, değiştirilme zamanı
    /// ve ayarları aynı olan dosyalar yeniden okunmaz.
    pub fn summarize(
        &self,
        path: &str,
        cfg: &StatsConfig,
        chosen: Option<Activity>,
    ) -> Result<(FileSummary, u64), SummaryError> {
        let meta = std::fs::metadata(path)
            .map_err(|e| SummaryError::Failed(format!("Dosya okunamadı: {e}")))?;
        let (size, mtime) = (meta.len(), mtime_ms(&meta));
        if let Some(e) = self
            .cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .entries
            .get(path)
        {
            if e.size == size && e.mtime == mtime && e.cfg == *cfg && e.chosen == chosen {
                return Ok((e.summary.clone(), e.fingerprint));
            }
        }
        let (gpx, size) = gpx_core::read_gpx_file(Path::new(path))?;
        // Parmak izi ham veriden: kopya tespiti ayarlardan etkilenmesin.
        let fingerprint = gpx_core::fingerprint(&gpx);
        // Gezilen yerler GPS gürültüsü temizliği kapalıyken de temiz veriden
        // bulunur: dünyanın öbür ucuna sıçrayan bir GPS hatası (ör. birkaç
        // dakika Boston) gidilmeyen bir ülke olarak sayılıyordu.
        let for_visits = (!cfg.clean_spikes).then(|| {
            let clean = StatsConfig {
                clean_spikes: true,
                ..*cfg
            };
            gpx_core::prepare(gpx.clone(), &clean).gpx
        });
        let prepared = gpx_core::prepare(gpx, cfg);
        let mut summary = gpx_core::summarize_with(&prepared.gpx, path, size, cfg, chosen)?;
        summary.removed_points = prepared.removed;
        summary.collapsed_points = prepared.collapsed;
        summary.time_zone = summary.start.and_then(|[lon, lat]| time_zone_at(lon, lat));
        summary.start_place = summary.start.and_then(|[lon, lat]| place_at(lon, lat));
        summary.end_place = summary.end.and_then(|[lon, lat]| place_at(lon, lat));
        // Uzun boşlukların (uçuş olabilecek) uçlarının adları.
        for g in summary.gaps.iter_mut().filter(|g| g.distance_m > 50_000.0) {
            g.from_place = place_at(g.from[0], g.from[1]);
            g.to_place = place_at(g.to[0], g.to[1]);
        }
        summary.visits = if summary.hours.is_empty() {
            untimed_visits(summary.start, summary.end, summary.stats.start_time)
        } else {
            visits(for_visits.as_ref().unwrap_or(&prepared.gpx), &summary.hours)
        };
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        if self.contains(Path::new(path)) {
            cache.entries.insert(
                path.to_owned(),
                CacheEntry {
                    size,
                    mtime,
                    cfg: *cfg,
                    chosen,
                    fingerprint,
                    summary: summary.clone(),
                },
            );
        } else {
            cache.seen.insert(
                path.to_owned(),
                SeenEntry {
                    size,
                    mtime,
                    fingerprint,
                },
            );
        }
        cache.changed.insert(path.to_owned());
        Ok((summary, fingerprint))
    }

    /// Önbellekteki özetten kaydın etkinlik türü (dosya değişmediyse); kayıt
    /// yeniden okunmaz.
    pub fn cached_activity(&self, path: &str) -> Option<Activity> {
        let meta = std::fs::metadata(path).ok()?;
        let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        let e = cache.entries.get(path)?;
        (e.size == meta.len() && e.mtime == mtime_ms(&meta)).then_some(e.summary.activity)
    }

    /// Önbellekteki değişiklikleri diske yazar; artık var olmayan dosyaların
    /// kayıtları atılır.
    pub fn flush_cache(&self) -> std::io::Result<()> {
        let _order = self
            .flush_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        // Disk denetimleri kilit dışında: ağ sürücüsündeki yollar yavaş
        // olabilir, bu sırada özet hesaplayan işler beklemesin.
        let paths: Vec<String> = {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            cache
                .entries
                .keys()
                .chain(cache.seen.keys())
                .cloned()
                .collect()
        };
        let gone: Vec<String> = paths
            .into_iter()
            .filter(|p| !Path::new(p).exists())
            .collect();
        let (bytes, append, lines, changed, was_full) = {
            let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            for p in gone {
                cache.entries.remove(&p);
                cache.seen.remove(&p);
                cache.changed.insert(p);
            }
            if cache.changed.is_empty() && !cache.full {
                return Ok(());
            }
            let live = cache.entries.len() + cache.seen.len();
            let compact = cache.full || cache.log_lines + cache.changed.len() > 2 * live + 2000;
            let mut buf = Vec::new();
            let mut lines = 0;
            let mut put = |line: LogLineRef| -> std::io::Result<()> {
                serde_json::to_writer(&mut buf, &line).map_err(std::io::Error::other)?;
                buf.push(b'\n');
                lines += 1;
                Ok(())
            };
            if compact {
                for (p, e) in &cache.entries {
                    put(LogLineRef::entry(p, e))?;
                }
                for (p, s) in &cache.seen {
                    put(LogLineRef::seen(p, s))?;
                }
            } else {
                for p in &cache.changed {
                    if let Some(e) = cache.entries.get(p) {
                        put(LogLineRef::entry(p, e))?;
                    } else if let Some(s) = cache.seen.get(p) {
                        put(LogLineRef::seen(p, s))?;
                    } else {
                        put(LogLineRef::del(p))?;
                    }
                }
            }
            let was_full = cache.full;
            cache.full = false;
            let changed = std::mem::take(&mut cache.changed);
            (buf, !compact, lines, changed, was_full)
        };
        let res = if append {
            append_sync(&self.cache_path, &bytes)
        } else {
            crate::store::write_atomic(&self.cache_path, &bytes)
        };
        let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
        match &res {
            Ok(()) => {
                cache.log_lines = if append {
                    cache.log_lines + lines
                } else {
                    lines
                };
                if !append {
                    let _ = std::fs::remove_file(&self.legacy_cache_path);
                }
            }
            Err(_) => {
                // Yazılamayanlar bir sonraki sefere kalır.
                cache.changed.extend(changed);
                cache.full |= was_full;
            }
        }
        res
    }

    /// Kütüphane dışındaki dosya daha önce görüldüyse ve değişmediyse,
    /// yeniden okumadan kopya sonucu: içeriği kütüphanede başka bir adla
    /// varsa ya da kullanıcı silmişse (kendiliğinden yüklemede).
    pub fn quick_duplicate(&self, path: &str, explicit: bool) -> Option<LoadResult> {
        if self.contains(Path::new(path)) {
            return None;
        }
        let meta = std::fs::metadata(path).ok()?;
        let fp = {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            let e = cache.seen.get(path)?;
            (e.size == meta.len() && e.mtime == mtime_ms(&meta)).then_some(e.fingerprint)?
        };
        if self.blocks(fp, path, explicit) {
            return Some(LoadResult::Duplicate {
                existing: path.to_owned(),
                path: path.to_owned(),
            });
        }
        let existing = self
            .known
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&fp)
            .cloned()?;
        (existing != path).then(|| LoadResult::Duplicate {
            path: path.to_owned(),
            existing,
        })
    }

    /// Okunan dosyayı kütüphaneye ekler: kopyasıysa atlar, dışarıdan
    /// geliyorsa kütüphane klasörüne kopyalar.
    pub fn add(
        &self,
        path: String,
        mut file: FileSummary,
        fingerprint: u64,
        cfg: &StatsConfig,
        chosen: Option<Activity>,
    ) -> LoadResult {
        let mut known = self.known.lock().unwrap_or_else(PoisonError::into_inner);
        // Özet hesaplanırken kütüphaneden silinmiş (çöp kutusuna taşınmış)
        // olabilir: silinen dosya yeniden kaydedilmez. Taşıma aynı kilit
        // altında yapıldığından bu denetim yarışmaz.
        if self.contains(Path::new(&path)) && !Path::new(&path).exists() {
            return LoadResult::Error {
                path,
                message: "Dosya bu sırada kaldırıldı".into(),
            };
        }
        if let Some(existing) = known.get(&fingerprint) {
            if *existing == path {
                return LoadResult::Ok {
                    file: Box::new(file),
                };
            }
            return LoadResult::Duplicate {
                path,
                existing: existing.clone(),
            };
        }
        let copied = !self.contains(Path::new(&path));
        let stored = if !copied {
            path
        } else {
            match self.copy_in(Path::new(&path)) {
                Ok(p) => p.to_string_lossy().into_owned(),
                Err(e) => {
                    return LoadResult::Error {
                        path,
                        message: format!("Kütüphaneye kopyalanamadı: {e}"),
                    }
                }
            }
        };
        known.insert(fingerprint, stored.clone());
        file.path = stored.clone();
        file.file_name = Path::new(&stored)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or(file.file_name);
        if copied {
            // Kopya aynı içerikte: bir sonraki açılışta yeniden okunmasın.
            if let Ok(meta) = std::fs::metadata(&stored) {
                file.file_size = meta.len();
                let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
                cache.entries.insert(
                    stored.clone(),
                    CacheEntry {
                        size: meta.len(),
                        mtime: mtime_ms(&meta),
                        cfg: *cfg,
                        chosen,
                        fingerprint,
                        summary: file.clone(),
                    },
                );
                cache.changed.insert(stored.clone());
            }
        }
        LoadResult::Ok {
            file: Box::new(file),
        }
    }

    /// Dosyayı okuyup kütüphaneye ekler.
    pub fn load(&self, path: String, cfg: &StatsConfig, chosen: Option<Activity>) -> LoadResult {
        match self.summarize(&path, cfg, chosen) {
            Ok((file, fp)) => self.add(path, file, fp, cfg, chosen),
            Err(e) => e.into_result(path),
        }
    }

    /// Kütüphanedeki dosyaları çöp kutusuna taşır. Taşınamayanlar atlanır;
    /// hiçbiri taşınamadıysa hata döner.
    pub fn trash(&self, paths: &[String]) -> Result<Vec<TrashItem>, String> {
        let mut known = self.known.lock().unwrap_or_else(PoisonError::into_inner);
        let mut out = Vec::new();
        let mut errors = Vec::new();
        let mut dismissed = Vec::new();
        for p in paths {
            let path = Path::new(p);
            if !self.contains(path) || !path.exists() {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let target = self.trash_dir.join(trash_name(now_ms(), &name));
            if let Err(e) = std::fs::rename(path, &target) {
                errors.push(format!("{name}: {e}"));
                continue;
            }
            let trashed = target.to_string_lossy().into_owned();
            let mut fps: Vec<u64> = known
                .iter()
                .filter(|(_, v)| *v == p)
                .map(|(k, _)| *k)
                .collect();
            if let Some(e) = self
                .cache
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .entries
                .get(p)
            {
                fps.push(e.fingerprint);
            }
            known.retain(|_, v| v != p);
            dismissed.extend(fps.into_iter().map(|fp| (fp, trashed.clone())));
            out.push(TrashItem {
                original: p.clone(),
                trashed,
            });
        }
        drop(known);
        if !dismissed.is_empty() {
            let mut map = self
                .dismissed
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            for (fp, trashed) in dismissed {
                map.entry(fp).or_default().insert(trashed);
            }
            self.save_dismissed(&map);
        }
        if out.is_empty() && !errors.is_empty() {
            return Err(format!("Silinemedi: {}", errors.join("; ")));
        }
        for e in errors {
            eprintln!("Silinemedi: {e}");
        }
        Ok(out)
    }

    /// Çöp kutusundaki dosyaları eski yerlerine (doluysa yeni bir ada)
    /// taşır. (çöp kutusundaki yol, yeni yol) çiftlerini döndürür.
    pub fn restore(&self, items: &[TrashItem]) -> Vec<(String, String)> {
        let mut out = Vec::new();
        for it in items {
            let src = Path::new(&it.trashed);
            if src.parent() != Some(self.trash_dir.as_path()) || !src.exists() {
                continue;
            }
            // Bu arada aynı içerik yeniden içe aktarıldıysa geri getirilmez:
            // listede görünmeyen, silinemeyen ikinci bir kopya kalıyordu.
            if let Ok((gpx, _)) = gpx_core::read_gpx_file(src) {
                if self
                    .known
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .contains_key(&gpx_core::fingerprint(&gpx))
                {
                    continue;
                }
            }
            let original = PathBuf::from(&it.original);
            let stem = original
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "iz".into());
            // Ad önce boş bir dosyayla ayrılır, sonra üzerine taşınır.
            let reserved = if self.contains(&original) {
                self.create_unique(&stem)
            } else {
                self.create_unique(&safe_stem(&stem))
            };
            let Ok((target, f)) = reserved else { continue };
            drop(f);
            if std::fs::rename(src, &target).is_ok() {
                out.push((it.trashed.clone(), target.to_string_lossy().into_owned()));
            } else {
                let _ = std::fs::remove_file(&target);
            }
        }
        // Aynı içeriğin herhangi bir kopyası geri gelince kayıt artık silinmiş
        // sayılmaz.
        let restored: Vec<&String> = out.iter().map(|(t, _)| t).collect();
        let mut map = self
            .dismissed
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let before = map.len();
        map.retain(|_, v| !v.is_empty() && !restored.iter().any(|t| v.contains(*t)));
        if map.len() != before {
            self.save_dismissed(&map);
        }
        out
    }

    fn purge_trash(&self, before_ms: i64) {
        for e in std::fs::read_dir(&self.trash_dir)
            .into_iter()
            .flatten()
            .flatten()
        {
            let name = e.file_name().to_string_lossy().into_owned();
            let stamp = name.split('-').next().and_then(|s| s.parse::<i64>().ok());
            if stamp.is_some_and(|t| t < before_ms) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

/// Dosyanın sonuna ekler ve diske işler.
fn append_sync(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    f.write_all(bytes)?;
    f.sync_data()
}

#[cfg(test)]
mod tests;
