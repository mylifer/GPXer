//! Kütüphane: açılan dosyaların uygulama klasöründeki kopyaları, özet
//! önbelleği ve silinen dosyalar için çöp kutusu.

use gpx_core::{Activity, FileSummary, Prepared, StatsConfig};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Önbellek biçimi ya da özet hesaplaması değiştiğinde artırılır; eski
/// önbellek yok sayılır.
const CACHE_VERSION: u32 = 7;
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
    /// Kullanıcının sildiği kayıtların parmak izi → çöp kutusundaki yolu.
    /// İzlenen klasörden yeniden eklenmezler.
    dismissed: Mutex<HashMap<u64, String>>,
    /// Son kullanılan hazırlanmış kayıtlar (grafik, aralık, kırpma için).
    prepared: Mutex<VecDeque<(PreparedKey, Arc<Prepared>)>>,
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
    Some(if r.cc == "TR" {
        turkish(&r.name)
    } else {
        r.name.clone()
    })
}

/// Veri kümesindeki adlar ASCII'ye çevrilmiş (Üsküdar → "UEskuedar").
/// Türkçe adlarda ü/ö geri getirilir; ş, ç, ğ, ı kaynağında olmadığından kalır.
fn turkish(name: &str) -> String {
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
            .and_then(|b| serde_json::from_slice(&b).ok())
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

    /// Kaydı silinenlerden çıkarır (kullanıcı yeniden açtı ya da geri aldı).
    pub fn undismiss(&self, fingerprint: u64) {
        let mut map = self.dismissed.lock().unwrap();
        if map.remove(&fingerprint).is_some() {
            self.save_dismissed(&map);
        }
    }

    fn save_dismissed(&self, map: &HashMap<u64, String>) {
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
            map.extend(dismissed);
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
        let restored: Vec<&String> = out.iter().map(|(t, _)| t).collect();
        let mut map = self.dismissed.lock().unwrap();
        let before = map.len();
        map.retain(|_, v| !restored.contains(&&*v));
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
