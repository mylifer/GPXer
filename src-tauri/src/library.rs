//! Kütüphane: açılan dosyaların uygulama klasöründeki kopyaları, özet
//! önbelleği ve silinen dosyalar için çöp kutusu.

use gpx_core::{Activity, FileSummary, Prepared, StatsConfig};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Önbellek biçimi ya da özet hesaplaması değiştiğinde artırılır; eski
/// önbellek yok sayılır.
const CACHE_VERSION: u32 = 11;
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

#[derive(Serialize, Deserialize, Default)]
struct CacheFile {
    version: u32,
    entries: HashMap<String, CacheEntry>,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<String, CacheEntry>,
    dirty: bool,
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
        .is_some_and(|e| e.eq_ignore_ascii_case("gpx"))
}

/// Açılabilen iz dosyası mı (GPX, FIT, TCX, KML).
pub fn is_track_file(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| gpx_core::formats::is_supported_ext(&e.to_string_lossy()))
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

/// Konumdan IANA saat dilimi adı (çevrimdışı veriyle).
pub fn time_zone_at(lon: f64, lat: f64) -> Option<String> {
    static FINDER: OnceLock<tzf_rs::DefaultFinder> = OnceLock::new();
    let name = FINDER
        .get_or_init(tzf_rs::DefaultFinder::new)
        .get_tz_name(lon, lat);
    (!name.is_empty()).then(|| name.to_owned())
}

/// Konuma en yakın yerleşim yerinin adı (GeoNames, çevrimdışı). 25 km'den
/// uzaktaki yerler (deniz, ıssız alan) ad vermez.
pub fn place_at(lon: f64, lat: f64) -> Option<String> {
    place_info(lon, lat).map(|(_, name)| name)
}

/// Konuma en yakın yerleşim yerinin ülke kodu ve (Türkiye'deyse Türkçe
/// yazımlı) adı; 25 km'den uzaktaysa `None`.
pub fn place_info(lon: f64, lat: f64) -> Option<(String, String)> {
    static GEO: OnceLock<reverse_geocoder::ReverseGeocoder> = OnceLock::new();
    let r = GEO
        .get_or_init(reverse_geocoder::ReverseGeocoder::new)
        .search((lat, lon))
        .record;
    let near = gpx_core::haversine_m(
        &gpx_core::parse::Point {
            lat,
            lon,
            ..Default::default()
        },
        &gpx_core::parse::Point {
            lat: r.lat,
            lon: r.lon,
            ..Default::default()
        },
    );
    if near > 25_000.0 {
        return None;
    }
    let name = if r.cc == "TR" {
        turkish(&r.name)
    } else {
        r.name.clone()
    };
    Some((r.cc.clone(), name))
}

/// Saat saat geçilen yerler: her saatin ilk noktasının yeri, yalnızca bir
/// öncekinden farklıysa (ardışık aynı yerler tek girdi). Yeri bulunamayan
/// (25 km'den uzak) saatler atlanır.
pub fn visits(gpx: &gpx_core::parse::Gpx, hours: &[[f64; 3]]) -> Vec<(i64, String, String)> {
    let mut out: Vec<(i64, String, String)> = Vec::new();
    for (hour, [lon, lat]) in gpx_core::hour_first_points(gpx, hours) {
        let Some((cc, name)) = place_info(lon, lat) else {
            continue;
        };
        if out.last().is_some_and(|(_, c, n)| *c == cc && *n == name) {
            continue;
        }
        out.push((hour, cc, name));
    }
    out
}

/// Veri kümesindeki Türkiye yer adları ASCII'ye çevrilmiş ("Kadikoy",
/// "UEskuedar"). Bilinen adlar tablodan Türkçe yazımlarıyla gelir; tabloda
/// olmayanlarda en azından Almanca tarzı ü/ö (ue/oe) geri getirilir.
fn turkish(name: &str) -> String {
    static TABLE: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        include_str!("tr_places.tsv")
            .lines()
            .filter(|l| !l.starts_with('#'))
            .filter_map(|l| l.split_once('\t'))
            .collect()
    });
    if let Some(t) = table.get(name) {
        return (*t).to_owned();
    }
    name.replace("UE", "Ü")
        .replace("Ue", "Ü")
        .replace("ue", "ü")
        .replace("OE", "Ö")
        .replace("Oe", "Ö")
        .replace("oe", "ö")
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
pub fn safe_stem(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let s: String = s.trim().trim_matches('.').chars().take(120).collect();
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
        let cache_path = root.join("summary-cache.json");
        let dismissed_path = root.join("dismissed.json");
        let dismissed = std::fs::read(&dismissed_path)
            .ok()
            .and_then(|b| parse_dismissed(&b))
            .unwrap_or_default();
        let entries = std::fs::read(&cache_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<CacheFile>(&b).ok())
            .filter(|c| c.version == CACHE_VERSION)
            .map(|c| c.entries)
            .unwrap_or_default();
        let lib = Library {
            dir,
            trash_dir,
            cache_path,
            dismissed_path,
            known: Mutex::default(),
            cache: Mutex::new(Cache {
                entries,
                dirty: false,
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
            let mut list = self.prepared.lock().unwrap();
            if let Some(pos) = list.iter().position(|(k, _)| *k == key) {
                let hit = list.remove(pos).unwrap();
                let p = hit.1.clone();
                list.push_front(hit);
                return Ok(p);
            }
        }
        let (p, _) = gpx_core::read_prepared(Path::new(path), cfg).map_err(|e| e.to_string())?;
        let p = Arc::new(p);
        let mut list = self.prepared.lock().unwrap();
        list.retain(|(k, _)| k.path != key.path);
        list.push_front((key, p.clone()));
        list.truncate(PREPARED_KEEP);
        Ok(p)
    }

    /// Silinen bir kaydın parmak izi mi (izlenen klasörden yeniden eklenmez).
    pub fn is_dismissed(&self, fingerprint: u64) -> bool {
        self.dismissed.lock().unwrap().contains_key(&fingerprint)
    }

    /// Yükleme silinen kayıt yüzünden atlanmalı mı: yalnızca kendiliğinden
    /// (elle açılmamış) ve kütüphane dışından gelen yüklemelerde.
    pub fn blocks(&self, fingerprint: u64, path: &str, explicit: bool) -> bool {
        !explicit && !self.contains(Path::new(path)) && self.is_dismissed(fingerprint)
    }

    /// Kaydı silinenlerden çıkarır (kullanıcı yeniden açtı ya da geri aldı).
    pub fn undismiss(&self, fingerprint: u64) {
        let mut map = self.dismissed.lock().unwrap();
        if map.remove(&fingerprint).is_some() {
            self.save_dismissed(&map);
        }
    }

    fn save_dismissed(&self, map: &Dismissed) {
        let res = serde_json::to_vec(map)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                let tmp = self.dismissed_path.with_extension("tmp");
                std::fs::write(&tmp, bytes)?;
                std::fs::rename(&tmp, &self.dismissed_path)
            });
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
    ) -> Result<(FileSummary, u64), String> {
        let meta = std::fs::metadata(path).map_err(|e| format!("Dosya okunamadı: {e}"))?;
        let (size, mtime) = (meta.len(), mtime_ms(&meta));
        if let Some(e) = self.cache.lock().unwrap().entries.get(path) {
            if e.size == size && e.mtime == mtime && e.cfg == *cfg && e.chosen == chosen {
                return Ok((e.summary.clone(), e.fingerprint));
            }
        }
        let (gpx, size) = gpx_core::read_gpx_file(Path::new(path)).map_err(|e| e.to_string())?;
        // Parmak izi ham veriden: kopya tespiti ayarlardan etkilenmesin.
        let fingerprint = gpx_core::fingerprint(&gpx);
        let prepared = gpx_core::prepare(gpx, cfg);
        let mut summary = gpx_core::summarize_with(&prepared.gpx, path, size, cfg, chosen)
            .map_err(|e| e.to_string())?;
        summary.removed_points = prepared.removed;
        summary.collapsed_points = prepared.collapsed;
        summary.time_zone = summary.start.and_then(|[lon, lat]| time_zone_at(lon, lat));
        summary.start_place = summary.start.and_then(|[lon, lat]| place_at(lon, lat));
        summary.end_place = summary.end.and_then(|[lon, lat]| place_at(lon, lat));
        summary.visits = visits(&prepared.gpx, &summary.hours);
        let mut cache = self.cache.lock().unwrap();
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
        cache.dirty = true;
        Ok((summary, fingerprint))
    }

    /// Önbelleği diske yazar; artık var olmayan dosyaların kayıtları atılır.
    pub fn flush_cache(&self) -> std::io::Result<()> {
        let mut cache = self.cache.lock().unwrap();
        let before = cache.entries.len();
        cache.entries.retain(|p, _| Path::new(p).exists());
        if !cache.dirty && before == cache.entries.len() {
            return Ok(());
        }
        let file = CacheFile {
            version: CACHE_VERSION,
            entries: std::mem::take(&mut cache.entries),
        };
        let res = serde_json::to_vec(&file)
            .map_err(std::io::Error::other)
            .and_then(|bytes| {
                // Yarım yazılmış önbellek kalmasın diye önce geçici dosyaya.
                let tmp = self.cache_path.with_extension("tmp");
                std::fs::write(&tmp, bytes)?;
                std::fs::rename(&tmp, &self.cache_path)
            });
        cache.entries = file.entries;
        if res.is_ok() {
            cache.dirty = false;
        }
        res
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
        let mut known = self.known.lock().unwrap();
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
                let mut cache = self.cache.lock().unwrap();
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
                cache.dirty = true;
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
            Err(message) => LoadResult::Error { path, message },
        }
    }

    /// Kütüphanedeki dosyaları çöp kutusuna taşır. Taşınamayanlar atlanır;
    /// hiçbiri taşınamadıysa hata döner.
    pub fn trash(&self, paths: &[String]) -> Result<Vec<TrashItem>, String> {
        let mut known = self.known.lock().unwrap();
        let mut out = Vec::new();
        let mut errors = Vec::new();
        let mut dismissed = Vec::new();
        for p in paths {
            let path = Path::new(p);
            if !self.contains(path) || !path.exists() {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let target = self.trash_dir.join(format!("{}-{name}", now_ms()));
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
            if let Some(e) = self.cache.lock().unwrap().entries.get(p) {
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
            let mut map = self.dismissed.lock().unwrap();
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
        let mut map = self.dismissed.lock().unwrap();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("gpxer-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn track(lat: &str) -> String {
        format!(
            r#"<gpx><trk><trkseg><trkpt lat="{lat}" lon="29"/><trkpt lat="41.01" lon="29"/></trkseg></trk></gpx>"#
        )
    }

    #[test]
    fn library_copies_and_detects_duplicates() {
        let root = temp_root("lib");
        let src = root.join("src");
        std::fs::create_dir_all(src.join("alt")).unwrap();
        std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
        std::fs::write(src.join("a-kopya.gpx"), track("41.000")).unwrap();
        std::fs::write(src.join("alt").join("a.gpx"), track("41.002")).unwrap();
        let cfg = StatsConfig::default();
        let s = |p: &Path| p.to_string_lossy().into_owned();

        let lib = Library::open(&root).unwrap();
        let LoadResult::Ok { file } = lib.load(s(&src.join("a.gpx")), &cfg, None) else {
            panic!()
        };
        assert_eq!(Path::new(&file.path), lib.dir.join("a.gpx"));
        assert_eq!(file.file_name, "a.gpx");
        // Konumdan saat dilimi ve yer adı bulunur.
        assert_eq!(file.time_zone.as_deref(), Some("Europe/Istanbul"));
        assert!(file.start_place.is_some(), "{:?}", file.start_place);

        let LoadResult::Duplicate { existing, .. } =
            lib.load(s(&src.join("a-kopya.gpx")), &cfg, None)
        else {
            panic!()
        };
        assert_eq!(Path::new(&existing), lib.dir.join("a.gpx"));

        // Aynı adlı ama farklı içerikli dosya yeni adla kopyalanır.
        let LoadResult::Ok { file } = lib.load(s(&src.join("alt").join("a.gpx")), &cfg, None)
        else {
            panic!()
        };
        assert_eq!(Path::new(&file.path), lib.dir.join("a (2).gpx"));
        lib.flush_cache().unwrap();

        // Yeniden başlatma: önbellek diskten okunur, kopyalar yine yakalanır.
        let lib2 = Library::open(&root).unwrap();
        // Kaynak dosyalar ve kütüphane kopyaları önbellekte.
        assert_eq!(lib2.cache.lock().unwrap().entries.len(), 3 + 2);
        for f in lib2.files() {
            assert!(matches!(lib2.load(f, &cfg, None), LoadResult::Ok { .. }));
        }
        assert!(matches!(
            lib2.load(s(&src.join("a.gpx")), &cfg, None),
            LoadResult::Duplicate { .. }
        ));
        assert_eq!(lib2.files().len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn imports_fit_as_gpx() {
        let root = temp_root("fit");
        let lib = Library::open(&root).unwrap();
        let src = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../crates/gpx-core/testdata/garmin-fenix-5-bike.fit"
        );
        let cfg = StatsConfig::default();
        let LoadResult::Ok { file } = lib.load(src.to_owned(), &cfg, None) else {
            panic!()
        };
        assert_eq!(
            Path::new(&file.path),
            lib.dir.join("garmin-fenix-5-bike.gpx")
        );
        assert_eq!(file.activity, Activity::Bike);
        // Kütüphanedeki GPX kopyası aynı kayıt sayılır.
        assert!(matches!(
            lib.load(src.to_owned(), &cfg, None),
            LoadResult::Duplicate { .. }
        ));
        let lib2 = Library::open(&root).unwrap();
        assert!(matches!(
            lib2.load(file.path.clone(), &cfg, None),
            LoadResult::Ok { .. }
        ));
        assert!(matches!(
            lib2.load(src.to_owned(), &cfg, None),
            LoadResult::Duplicate { .. }
        ));
        assert_eq!(turkish("UEskuedar"), "Üsküdar");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn cache_invalidates_on_change() {
        let root = temp_root("cache");
        let lib = Library::open(&root).unwrap();
        let p = lib.write_new("x/y:z", &track("41.0")).unwrap();
        assert_eq!(p.file_name().unwrap(), "x-y-z.gpx");
        let ps = p.to_string_lossy().into_owned();
        let cfg = StatsConfig::default();
        let (a, _) = lib.summarize(&ps, &cfg, None).unwrap();
        // Farklı ayarla yeniden hesaplanır.
        let strict = StatsConfig {
            moving_speed_ms: 9.0,
            ..cfg
        };
        lib.summarize(&ps, &strict, None).unwrap();
        assert_eq!(lib.cache.lock().unwrap().entries[&ps].cfg, strict);
        // İçerik değişince yeniden okunur.
        std::fs::write(&p, track("40.0")).unwrap();
        let (b, _) = lib.summarize(&ps, &cfg, None).unwrap();
        assert_ne!(a.stats.distance_m, b.stats.distance_m);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_and_restore() {
        let root = temp_root("trash");
        let lib = Library::open(&root).unwrap();
        let cfg = StatsConfig::default();
        let p = lib.write_new("a", &track("41.0")).unwrap();
        let ps = p.to_string_lossy().into_owned();
        assert!(matches!(
            lib.load(ps.clone(), &cfg, None),
            LoadResult::Ok { .. }
        ));
        let items = lib.trash(std::slice::from_ref(&ps)).unwrap();
        assert_eq!(items.len(), 1);
        assert!(!p.exists());
        assert!(lib.files().is_empty());
        let back = lib.restore(&items);
        assert_eq!(back, vec![(items[0].trashed.clone(), ps.clone())]);
        assert!(matches!(lib.load(ps, &cfg, None), LoadResult::Ok { .. }));
        // Eski çöp dosyaları temizlenir.
        let items = lib.trash(&lib.files()).unwrap();
        lib.purge_trash(now_ms() + 1);
        assert!(!Path::new(&items[0].trashed).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_stem("CON"), "_CON");
        assert_eq!(safe_stem("lpt1.txt"), "_lpt1.txt");
        assert_eq!(safe_stem("COM0"), "COM0");
        assert_eq!(safe_stem("Konsol"), "Konsol");
        assert_eq!(safe_stem("iz. . "), "iz");
        assert_eq!(safe_stem(" .. "), "iz");
        let long = format!("{} x", "a".repeat(119));
        assert_eq!(safe_stem(&long), "a".repeat(119));
    }

    #[test]
    fn dismissed_until_restored() {
        let root = temp_root("dismiss");
        let lib = Library::open(&root).unwrap();
        let cfg = StatsConfig::default();
        let src = root.join("izlenen");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
        let sp = src.join("a.gpx").to_string_lossy().into_owned();
        let (_, fp) = lib.summarize(&sp, &cfg, None).unwrap();
        let LoadResult::Ok { file } = lib.load(sp.clone(), &cfg, None) else {
            panic!()
        };
        assert!(!lib.is_dismissed(fp));
        let items = lib.trash(std::slice::from_ref(&file.path)).unwrap();
        assert!(lib.is_dismissed(fp));
        // Yeniden başlatmada da hatırlanır.
        assert!(Library::open(&root).unwrap().is_dismissed(fp));
        let back = lib.restore(&items);
        assert_eq!(back.len(), 1);
        assert!(!lib.is_dismissed(fp));
        assert!(!Library::open(&root).unwrap().is_dismissed(fp));
        // Aynı ad doluysa geri gelen dosya yeni ad alır.
        let items = lib.trash(std::slice::from_ref(&back[0].1)).unwrap();
        lib.write_new("a", &track("40.0")).unwrap();
        let back = lib.restore(&items);
        assert_eq!(Path::new(&back[0].1), lib.dir.join("a (2).gpx"));
        // Kütüphane dışındaki yol reddedilir.
        assert!(lib.check(&sp).is_err());
        assert!(lib.check(&back[0].1).is_ok());
        let up = lib.dir.join("..").join("x.gpx");
        assert!(lib.check(&up.to_string_lossy()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dismissal_blocks_only_implicit_loads() {
        let root = temp_root("explicit");
        let lib = Library::open(&root).unwrap();
        let cfg = StatsConfig::default();
        let src = root.join("izlenen");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
        let sp = src.join("a.gpx").to_string_lossy().into_owned();
        let LoadResult::Ok { file } = lib.load(sp.clone(), &cfg, None) else {
            panic!()
        };
        let (_, fp) = lib.summarize(&sp, &cfg, None).unwrap();
        lib.trash(std::slice::from_ref(&file.path)).unwrap();
        // İzlenen klasörden kendiliğinden gelen yükleme atlanır, elle açılan
        // atlanmaz.
        assert!(lib.blocks(fp, &sp, false));
        assert!(!lib.blocks(fp, &sp, true));
        // Kütüphanedeki dosyalar hiçbir zaman atlanmaz.
        let inside = lib.dir.join("a.gpx").to_string_lossy().into_owned();
        assert!(!lib.blocks(fp, &inside, false));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restoring_older_trash_copy_clears_dismissal() {
        let root = temp_root("twice");
        let lib = Library::open(&root).unwrap();
        let cfg = StatsConfig::default();
        let p = lib.write_new("a", &track("41.0")).unwrap();
        let ps = p.to_string_lossy().into_owned();
        let (_, fp) = lib.summarize(&ps, &cfg, None).unwrap();
        assert!(matches!(
            lib.load(ps.clone(), &cfg, None),
            LoadResult::Ok { .. }
        ));
        let first = lib.trash(std::slice::from_ref(&ps)).unwrap();
        // Aynı içerik yeniden eklenip yeniden silinir.
        std::thread::sleep(std::time::Duration::from_millis(5));
        let q = lib.write_new("a", &track("41.0")).unwrap();
        let qs = q.to_string_lossy().into_owned();
        assert!(matches!(
            lib.load(qs.clone(), &cfg, None),
            LoadResult::Ok { .. }
        ));
        let second = lib.trash(std::slice::from_ref(&qs)).unwrap();
        assert_ne!(first[0].trashed, second[0].trashed);
        assert_eq!(lib.dismissed.lock().unwrap()[&fp].len(), 2);
        // Eskisi geri getirilince de kayıt silinmiş sayılmaz.
        assert_eq!(lib.restore(&first).len(), 1);
        assert!(!lib.is_dismissed(fp));
        assert!(!Library::open(&root).unwrap().is_dismissed(fp));
        // Eski biçimdeki dismissed.json okunur.
        std::fs::write(
            root.join("dismissed.json"),
            format!(r#"{{"{fp}":"/x/1-a.gpx"}}"#),
        )
        .unwrap();
        assert!(Library::open(&root).unwrap().is_dismissed(fp));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unique_names_and_prepared_cache() {
        let root = temp_root("unique");
        let lib = Library::open(&root).unwrap();
        let a = lib.write_new("b", "1").unwrap();
        let b = lib.write_new("b", "2").unwrap();
        assert_eq!(b.file_name().unwrap(), "b (2).gpx");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "1");
        // Aynı anda yazılan kayıtlar farklı adlar alır.
        let lib_ref = &lib;
        let names: Vec<PathBuf> = std::thread::scope(|s| {
            let hs: Vec<_> = (0..8)
                .map(|i| s.spawn(move || lib_ref.write_new("c", &i.to_string()).unwrap()))
                .collect();
            hs.into_iter().map(|h| h.join().unwrap()).collect()
        });
        let set: std::collections::HashSet<_> = names.iter().collect();
        assert_eq!(set.len(), 8);

        let p = lib.write_new("d", &track("41.0")).unwrap();
        let ps = p.to_string_lossy().into_owned();
        let cfg = StatsConfig::default();
        let x = lib.prepared(&ps, &cfg).unwrap();
        let y = lib.prepared(&ps, &cfg).unwrap();
        assert!(Arc::ptr_eq(&x, &y));
        let other = StatsConfig {
            clean_spikes: false,
            ..cfg
        };
        assert!(!Arc::ptr_eq(&x, &lib.prepared(&ps, &other).unwrap()));
        assert_eq!(lib.prepared.lock().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod place_tests {
    use super::*;

    #[test]
    fn turkish_place_names() {
        assert_eq!(turkish("Kadikoy"), "Kadıköy");
        assert_eq!(turkish("UEskuedar"), "Üsküdar");
        assert_eq!(turkish("Sisli"), "Şişli");
        assert_eq!(turkish("Ankara"), "Ankara");
        // Şişli'deki bir nokta.
        assert_eq!(place_at(28.987, 41.060).as_deref(), Some("Şişli"));
    }

    #[test]
    fn hourly_visits_are_run_length_compressed() {
        use gpx_core::parse::{Gpx, Point, Track};
        let pt = |lon: f64, lat: f64, h: i64, m: i64| Point {
            lat,
            lon,
            time: Some(h * 3_600_000 + m * 60_000),
            ..Default::default()
        };
        // Şişli'de iki saat, sonra Kadıköy, açık denizde bir saat, yine Şişli.
        let seg = vec![
            pt(28.987, 41.060, 0, 0),
            pt(28.987, 41.061, 0, 30),
            pt(28.988, 41.060, 1, 0),
            pt(29.03, 40.99, 2, 5),
            pt(29.031, 40.99, 2, 50),
            pt(-30.0, 40.0, 3, 1),
            pt(-30.0, 40.0, 3, 2),
            pt(28.987, 41.060, 4, 0),
            pt(28.987, 41.060, 4, 1),
        ];
        let gpx = Gpx {
            tracks: vec![Track {
                name: None,
                segments: vec![seg],
            }],
            ..Default::default()
        };
        let hours: Vec<[f64; 3]> = (0..5).map(|h| [(h * 3_600_000) as f64, 0.0, 0.0]).collect();
        let v = visits(&gpx, &hours);
        let names: Vec<(i64, &str, &str)> = v
            .iter()
            .map(|(h, c, n)| (*h, c.as_str(), n.as_str()))
            .collect();
        assert_eq!(names.len(), 3, "{names:?}");
        assert_eq!(names[0], (0, "TR", "Şişli"));
        assert_eq!(names[1].0, 2 * 3_600_000);
        assert_eq!(names[1].1, "TR");
        assert_ne!(names[1].2, "Şişli");
        assert_eq!(names[2], (4 * 3_600_000, "TR", "Şişli"));
    }
}
