//! Fotoğrafların EXIF bilgileri: çekim zamanı, GPS konumu ve gömülü küçük
//! resim. Fotoğraflar kütüphaneye kopyalanmaz; yalnızca okunur.

use crate::run_blocking;
use base64::Engine;
use exif::{In, Tag, Value};
use notify_debouncer_mini::notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Bir seferde okunan en fazla fotoğraf sayısı.
pub const MAX_PHOTOS: usize = 5000;
/// Gömülü küçük resim bundan büyükse alınmaz (bozuk EXIF'e karşı).
const MAX_THUMB_BYTES: usize = 256 * 1024;
/// Bundan büyük dosyalar (video, ham panorama…) okunmaz.
const MAX_FILE_BYTES: u64 = 150 * 1024 * 1024;
/// TIFF'te EXIF için dosyanın en fazla bu kadar başı okunur.
const MAX_TIFF_READ: u64 = 16 * 1024 * 1024;
/// Klasör taramasında inilecek en fazla derinlik.
const MAX_DEPTH: usize = 12;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhotoInfo {
    pub path: String,
    pub name: String,
    /// Çekim zamanı (Unix ms).
    pub time: Option<i64>,
    /// EXIF'te saat farkı (OffsetTimeOriginal/OffsetTime) ya da GPS zamanı
    /// yoksa `true`: zaman, yerel saat UTC'ymiş gibi hesaplanmıştır; arayüz
    /// kaydın saat dilimine göre düzeltir.
    pub time_is_local: bool,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Her zaman `None`: küçük resim ayrıca `photo_thumb` ile istenir.
    pub thumb: Option<String>,
}

/// Desteklenen fotoğraf uzantısı mı (büyük/küçük harf duyarsız).
pub fn is_photo(path: &Path) -> bool {
    path.extension().is_some_and(|e| {
        let e = e.to_string_lossy().to_ascii_lowercase();
        matches!(
            e.as_str(),
            "jpg" | "jpeg" | "heic" | "heif" | "tif" | "tiff" | "png"
        )
    })
}

/// Taramada içine girilmeyen klasör mü: gizli klasörler, macOS paketleri ve
/// Windows sistem klasörleri.
fn is_skipped_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    let lower = name.to_ascii_lowercase();
    let package = [
        ".app",
        ".photoslibrary",
        ".photolibrary",
        ".bundle",
        ".framework",
    ]
    .iter()
    .any(|ext| lower.ends_with(ext));
    package || lower == "$recycle.bin" || lower == "system volume information"
}

/// Dosya ve klasörlerden (özyinelemeli) fotoğraf yolları; tekilleştirilmiş,
/// en fazla [`MAX_PHOTOS`] tane. Sınıra ulaşınca tarama durur. Doğrudan
/// verilen dosyalar uzantıya bakılmadan alınır. Bağlantılar izlenmez; gizli,
/// paket ve sistem klasörleri ile çok büyük dosyalar atlanır.
pub fn expand(paths: &[String]) -> Vec<PathBuf> {
    expand_limited(paths, MAX_PHOTOS)
}

fn expand_limited(paths: &[String], limit: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for p in paths {
        let path = PathBuf::from(p);
        if path.is_dir() {
            let walker = walkdir::WalkDir::new(&path)
                .follow_links(false)
                .max_depth(MAX_DEPTH)
                .sort_by_file_name()
                .into_iter()
                .filter_entry(|e| {
                    e.depth() == 0
                        || !e.file_type().is_dir()
                        || !is_skipped_dir(&e.file_name().to_string_lossy())
                });
            for e in walker.filter_map(Result::ok) {
                if out.len() >= limit {
                    return out;
                }
                if !e.file_type().is_file() || !is_photo(e.path()) {
                    continue;
                }
                if e.metadata().is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
                    continue;
                }
                let f = e.into_path();
                if seen.insert(f.clone()) {
                    out.push(f);
                }
            }
        } else if path.is_file() {
            if out.len() >= limit {
                return out;
            }
            if seen.insert(path.clone()) {
                out.push(path);
            }
        }
    }
    out
}

/// Fotoğrafları paralel olarak okur. Açılamayan dosyalar atlanır; EXIF'i
/// okunamayanlar bilgisiz döner.
pub fn read_all(paths: &[String]) -> Vec<PhotoInfo> {
    expand(paths)
        .par_iter()
        .filter_map(|p| read_photo(p))
        .collect()
}

/// Dosyanın EXIF'i. TIFF'te yalnızca dosyanın başı okunur; çok büyük
/// dosyalar okunmaz.
fn read_exif(file: std::fs::File) -> Option<exif::Exif> {
    use std::io::Read;
    let mut reader = std::io::BufReader::new(file);
    let mut head = [0u8; 4];
    let n = reader.read(&mut head).ok()?;
    reader.seek_relative(-(n as i64)).ok()?;
    if head[..n] == *b"II*\0" || head[..n] == *b"MM\0*" {
        let mut buf = Vec::new();
        reader.take(MAX_TIFF_READ).read_to_end(&mut buf).ok()?;
        return exif::Reader::new().read_raw(buf).ok();
    }
    exif::Reader::new().read_from_container(&mut reader).ok()
}

/// Okunabilecek normal bir dosyayı açar.
fn open_photo(path: &Path) -> Option<std::fs::File> {
    let file = std::fs::File::open(path).ok()?;
    let meta = file.metadata().ok()?;
    (meta.is_file() && meta.len() <= MAX_FILE_BYTES).then_some(file)
}

pub fn read_photo(path: &Path) -> Option<PhotoInfo> {
    let file = open_photo(path)?;
    let mut info = PhotoInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        time: None,
        time_is_local: false,
        lat: None,
        lon: None,
        thumb: None,
    };
    let Some(exif) = read_exif(file) else {
        return Some(info);
    };
    if let Some((t, local)) = taken_at(&exif) {
        info.time = Some(t);
        info.time_is_local = local;
    }
    if let Some((lat, lon)) = gps(&exif) {
        info.lat = Some(lat);
        info.lon = Some(lon);
    }
    Some(info)
}

/// EXIF'e gömülü küçük resim (`data:image/jpeg;base64,…`); yoksa `None`.
pub fn thumb_data_url(path: &Path) -> Option<String> {
    let exif = read_exif(open_photo(path)?)?;
    thumbnail(&exif).map(|b| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b)
        )
    })
}

fn ascii(exif: &exif::Exif, tag: Tag) -> Option<&[u8]> {
    match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(v) => v.first().map(Vec::as_slice),
        _ => None,
    }
}

/// Çekim zamanı (Unix ms) ve saat farkının bilinmediği (yerel saat) mi.
/// Saat farkı yoksa (OffsetTimeOriginal/Digitized, o da yoksa OffsetTime)
/// GPS tarih ve saati (UTC) yerel saate tercih edilir.
fn taken_at(exif: &exif::Exif) -> Option<(i64, bool)> {
    let sources = [
        (
            Tag::DateTimeOriginal,
            Tag::OffsetTimeOriginal,
            Tag::SubSecTimeOriginal,
        ),
        (
            Tag::DateTimeDigitized,
            Tag::OffsetTimeDigitized,
            Tag::SubSecTimeDigitized,
        ),
        (Tag::DateTime, Tag::OffsetTime, Tag::SubSecTime),
    ];
    let camera = sources.iter().find_map(|&(dt, off, sub)| {
        let mut d = exif::DateTime::from_ascii(ascii(exif, dt)?).ok()?;
        if let Some(s) = ascii(exif, sub) {
            let _ = d.parse_subsec(s);
        }
        if let Some(o) = ascii(exif, off).or_else(|| ascii(exif, Tag::OffsetTime)) {
            let _ = d.parse_offset(o);
        }
        Some((civil_ms(&d)?, d.offset))
    });
    match camera {
        Some((local, Some(min))) => Some((local - i64::from(min) * 60_000, false)),
        _ => match (gps_time(exif), camera) {
            (Some(utc), local) => {
                // GPS saniyesi tam sayıysa ve yerel saatle aynı saniyeye
                // denk geliyorsa yerel saatin saniye kesri korunur.
                let frac = local.map_or(0, |(l, _)| l.rem_euclid(1000));
                let same_second = local.is_some_and(|(l, _)| (l - frac - utc) % 60_000 == 0);
                if utc % 1000 == 0 && same_second {
                    Some((utc + frac, false))
                } else {
                    Some((utc, false))
                }
            }
            (None, Some((local, None))) => Some((local, true)),
            (None, _) => None,
        },
    }
}

/// GPSDateStamp ve GPSTimeStamp'ten UTC zaman (Unix ms, saniye kesriyle).
fn gps_time(exif: &exif::Exif) -> Option<i64> {
    let date = std::str::from_utf8(ascii(exif, Tag::GPSDateStamp)?).ok()?;
    let date = date.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    let d = exif::DateTime::from_ascii(format!("{date} 00:00:00").as_bytes()).ok()?;
    let day = civil_ms(&d)?;
    let Value::Rational(v) = &exif.get_field(Tag::GPSTimeStamp, In::PRIMARY)?.value else {
        return None;
    };
    if v.len() < 3 || v.iter().any(|r| r.denom == 0) {
        return None;
    }
    let (h, m, s) = (v[0].to_f64(), v[1].to_f64(), v[2].to_f64());
    if !(0.0..24.0).contains(&h) || !(0.0..60.0).contains(&m) || !(0.0..61.0).contains(&s) {
        return None;
    }
    let ms = ((h * 3600.0 + m * 60.0 + s) * 1000.0).round() as i64;
    Some(day + ms)
}

/// Takvim tarihini ve saati UTC'ymiş gibi Unix ms'ye çevirir.
fn civil_ms(d: &exif::DateTime) -> Option<i64> {
    if !(1..=12).contains(&d.month) || !(1..=31).contains(&d.day) || d.hour > 23 || d.minute > 59 {
        return None;
    }
    // Howard Hinnant'ın days_from_civil algoritması.
    let (m, y) = (i64::from(d.month), i64::from(d.year));
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d.day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400
        + i64::from(d.hour) * 3600
        + i64::from(d.minute) * 60
        + i64::from(d.second.min(60));
    Some(secs * 1000 + i64::from(d.nanosecond.unwrap_or(0) / 1_000_000))
}

/// Derece/dakika/saniye rasyonellerinden ondalık derece.
fn dms(exif: &exif::Exif, tag: Tag) -> Option<f64> {
    match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Rational(v) if !v.is_empty() => {
            let part = |i: usize| v.get(i).map_or(0.0, |r| r.to_f64());
            let deg = part(0) + part(1) / 60.0 + part(2) / 3600.0;
            deg.is_finite().then_some(deg)
        }
        _ => None,
    }
}

fn gps(exif: &exif::Exif) -> Option<(f64, f64)> {
    let mut lat = dms(exif, Tag::GPSLatitude)?;
    let mut lon = dms(exif, Tag::GPSLongitude)?;
    if ascii(exif, Tag::GPSLatitudeRef).is_some_and(|r| r.eq_ignore_ascii_case(b"S")) {
        lat = -lat;
    }
    if ascii(exif, Tag::GPSLongitudeRef).is_some_and(|r| r.eq_ignore_ascii_case(b"W")) {
        lon = -lon;
    }
    // Bazı cihazlar konum yokken 0,0 yazar.
    let valid = lat.abs() <= 90.0 && lon.abs() <= 180.0 && (lat != 0.0 || lon != 0.0);
    valid.then_some((lat, lon))
}

/// EXIF'e gömülü JPEG küçük resmi (IFD1).
fn thumbnail(exif: &exif::Exif) -> Option<&[u8]> {
    let uint = |tag| exif.get_field(tag, In::THUMBNAIL)?.value.get_uint(0);
    let off = uint(Tag::JPEGInterchangeFormat)? as usize;
    let len = uint(Tag::JPEGInterchangeFormatLength)? as usize;
    if len == 0 || len > MAX_THUMB_BYTES {
        return None;
    }
    let bytes = exif.buf().get(off..off.checked_add(len)?)?;
    bytes.starts_with(&[0xFF, 0xD8]).then_some(bytes)
}

/// Bu oturumda `read_photos` ile döndürülen fotoğraf yolları; küçük resim
/// yalnızca bunlar için okunur.
#[derive(Default)]
pub(crate) struct PhotoPaths(Mutex<HashSet<String>>);

/// Fotoğrafların (dosyalar ya da klasörler) çekim zamanı ve konumu. Küçük
/// resim (`thumb`) her zaman boştur; `photo_thumb` ile ayrıca istenir.
#[tauri::command]
pub(crate) async fn read_photos(
    app: AppHandle,
    paths: Vec<String>,
) -> Result<Vec<PhotoInfo>, String> {
    run_blocking(move || {
        let list = read_all(&paths);
        app.state::<PhotoPaths>()
            .0
            .lock()
            .unwrap()
            .extend(list.iter().map(|p| p.path.clone()));
        list
    })
    .await
}

/// Fotoğrafın EXIF'e gömülü küçük resmi (data URL). Yalnızca daha önce
/// `read_photos` ile döndürülmüş yollar için; diğerlerinde ve küçük resim
/// yoksa `None`.
#[tauri::command]
pub(crate) async fn photo_thumb(app: AppHandle, path: String) -> Result<Option<String>, String> {
    run_blocking(move || {
        if !app.state::<PhotoPaths>().0.lock().unwrap().contains(&path) {
            return None;
        }
        thumb_data_url(Path::new(&path))
    })
    .await
}

/// Fotoğraf klasörlerinin dosya sistemi izleyicisi: klasöre yeni fotoğraf
/// düşünce (telefondan aktarma, bulut eşitlemesi) okunup arayüze bildirilir.
#[derive(Default)]
pub(crate) struct PhotoWatcher(Mutex<Option<Debouncer<RecommendedWatcher>>>);

/// Verilen yollardan klasör olanları izler (öncekilerin yerine); yeni ya da
/// değişen fotoğraflar okunup `photos-added` olayıyla gönderilir. İzlenemeyen
/// klasörlerin hata iletileri döner.
#[tauri::command]
pub(crate) async fn watch_photo_folders(
    app: AppHandle,
    folders: Vec<String>,
) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let dirs: Vec<PathBuf> = folders
            .iter()
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .collect();
        let state = app.state::<PhotoWatcher>();
        let mut slot = state.0.lock().unwrap();
        *slot = None;
        if dirs.is_empty() {
            return Vec::new();
        }
        let handle = app.clone();
        // Telefon/bulut aktarmaları dosyayı parça parça yazabilir: birkaç
        // saniyelik sessizlik beklenir.
        let debouncer = new_debouncer(Duration::from_secs(4), move |res: DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<String> = events
                .into_iter()
                .map(|e| e.path)
                .filter(|p| p.is_file() && is_photo(p))
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            paths.sort();
            paths.dedup();
            if paths.is_empty() {
                return;
            }
            let list = read_all(&paths);
            if list.is_empty() {
                return;
            }
            handle
                .state::<PhotoPaths>()
                .0
                .lock()
                .unwrap()
                .extend(list.iter().map(|p| p.path.clone()));
            let _ = handle.emit("photos-added", list);
        });
        let mut debouncer = match debouncer {
            Ok(d) => d,
            Err(e) => return vec![format!("Fotoğraf klasörü izlenemiyor: {e}")],
        };
        let mut errors = Vec::new();
        for d in &dirs {
            if let Err(e) = debouncer.watcher().watch(d, RecursiveMode::Recursive) {
                errors.push(format!("{} izlenemiyor: {e}", d.display()));
            }
        }
        *slot = Some(debouncer);
        errors
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use exif::experimental::Writer;
    use exif::{Field, Rational};

    fn ascii_field(tag: Tag, s: &str) -> Field {
        Field {
            tag,
            ifd_num: In::PRIMARY,
            value: Value::Ascii(vec![s.as_bytes().to_vec()]),
        }
    }

    fn rationals(tag: Tag, v: [(u32, u32); 3]) -> Field {
        Field {
            tag,
            ifd_num: In::PRIMARY,
            value: Value::Rational(
                v.iter()
                    .map(|&(num, denom)| Rational { num, denom })
                    .collect(),
            ),
        }
    }

    /// EXIF'li en küçük JPEG: SOI + APP1(Exif) + EOI.
    fn jpeg(fields: &[Field], thumb: Option<&[u8]>) -> Vec<u8> {
        let mut w = Writer::new();
        for f in fields {
            w.push_field(f);
        }
        if let Some(t) = thumb {
            w.set_jpeg(t, In::THUMBNAIL);
        }
        let mut tiff = std::io::Cursor::new(Vec::new());
        w.write(&mut tiff, false).unwrap();
        let tiff = tiff.into_inner();
        let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
        out.extend_from_slice(&((tiff.len() + 8) as u16).to_be_bytes());
        out.extend_from_slice(b"Exif\0\0");
        out.extend_from_slice(&tiff);
        out.extend_from_slice(&[0xFF, 0xD9]);
        out
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gpxer-photos-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn reads_time_gps_and_thumbnail() {
        let dir = temp_dir("read");
        let thumb = [0xFF, 0xD8, 0xFF, 0xD9];
        let with_offset = jpeg(
            &[
                ascii_field(Tag::DateTimeOriginal, "2024:05:01 09:30:15"),
                ascii_field(Tag::OffsetTimeOriginal, "+03:00"),
                ascii_field(Tag::SubSecTimeOriginal, "25"),
                ascii_field(Tag::GPSLatitudeRef, "N"),
                rationals(Tag::GPSLatitude, [(41, 1), (3, 1), (3600, 100)]),
                ascii_field(Tag::GPSLongitudeRef, "W"),
                rationals(Tag::GPSLongitude, [(28, 1), (59, 1), (0, 1)]),
            ],
            Some(&thumb),
        );
        std::fs::write(dir.join("a.JPG"), with_offset).unwrap();
        let local = jpeg(
            &[ascii_field(Tag::DateTimeOriginal, "2024:05:01 09:30:15")],
            None,
        );
        std::fs::create_dir_all(dir.join("alt")).unwrap();
        std::fs::write(dir.join("alt").join("b.jpeg"), local).unwrap();
        std::fs::write(dir.join("c.png"), b"bozuk").unwrap();
        std::fs::write(dir.join("not.txt"), b"x").unwrap();

        let d = dir.to_string_lossy().into_owned();
        let mut photos = read_all(&[d.clone(), d]);
        photos.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = photos.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["a.JPG", "b.jpeg", "c.png"]);

        // 2024-05-01T06:30:15.250Z
        let a = &photos[0];
        assert_eq!(a.time, Some(1_714_545_015_250));
        assert!(!a.time_is_local);
        assert!((a.lat.unwrap() - (41.0 + 3.0 / 60.0 + 36.0 / 3600.0)).abs() < 1e-9);
        assert!((a.lon.unwrap() + (28.0 + 59.0 / 60.0)).abs() < 1e-9);
        // Küçük resim listede gelmez, ayrıca istenir.
        assert_eq!(a.thumb, None);
        assert_eq!(
            thumb_data_url(Path::new(&a.path)).as_deref(),
            Some("data:image/jpeg;base64,/9j/2Q==")
        );

        let b = &photos[1];
        assert_eq!(b.time, Some(1_714_555_815_000));
        assert!(b.time_is_local);
        assert_eq!((b.lat, b.lon, b.thumb.as_deref()), (None, None, None));
        assert_eq!(thumb_data_url(Path::new(&b.path)), None);

        // EXIF'i okunamayan dosya bilgisiz döner.
        assert_eq!(photos[2].time, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expands_folders_with_limit() {
        let dir = temp_dir("expand");
        for i in 0..3 {
            std::fs::write(dir.join(format!("{i}.HEIC")), b"").unwrap();
        }
        std::fs::write(dir.join("x.gpx"), b"").unwrap();
        let d = dir.to_string_lossy().into_owned();
        assert_eq!(expand(std::slice::from_ref(&d)).len(), 3);
        assert!(expand(&["/yok/boyle/bir/yer".into()]).is_empty());
        assert!(is_photo(Path::new("a.TiF")));
        assert!(!is_photo(Path::new("a.gif")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// EXIF'li çıplak TIFF.
    fn tiff(fields: &[Field]) -> Vec<u8> {
        let mut w = Writer::new();
        for f in fields {
            w.push_field(f);
        }
        let mut out = std::io::Cursor::new(Vec::new());
        w.write(&mut out, false).unwrap();
        out.into_inner()
    }

    fn time_of(dir: &Path, name: &str, fields: &[Field]) -> (Option<i64>, bool) {
        let p = dir.join(name);
        std::fs::write(&p, jpeg(fields, None)).unwrap();
        let info = read_photo(&p).unwrap();
        (info.time, info.time_is_local)
    }

    #[test]
    fn offset_and_gps_times() {
        let dir = temp_dir("times");
        let dto = ascii_field(Tag::DateTimeOriginal, "2024:05:01 09:30:15");
        // 2024-05-01T06:30:15Z
        let utc = 1_714_545_015_000;
        // OffsetTimeOriginal yoksa IFD0'daki OffsetTime kullanılır.
        let t = time_of(
            &dir,
            "a.jpg",
            &[dto.clone(), ascii_field(Tag::OffsetTime, "+03:00")],
        );
        assert_eq!(t, (Some(utc), false));
        // GPS zamanı (UTC) yerel saate tercih edilir; saniye kesri korunur.
        let gps_date = ascii_field(Tag::GPSDateStamp, "2024:05:01");
        let gps_ts = |s: (u32, u32)| rationals(Tag::GPSTimeStamp, [(6, 1), (30, 1), s]);
        let t = time_of(
            &dir,
            "b.jpg",
            &[
                dto.clone(),
                ascii_field(Tag::SubSecTimeOriginal, "5"),
                gps_date.clone(),
                gps_ts((15, 1)),
            ],
        );
        assert_eq!(t, (Some(utc + 500), false));
        // GPS saniyesi kesirliyse o kullanılır.
        let t = time_of(
            &dir,
            "c.jpg",
            &[dto.clone(), gps_date.clone(), gps_ts((1525, 100))],
        );
        assert_eq!(t, (Some(utc + 250), false));
        // Yalnızca GPS zamanı.
        let t = time_of(&dir, "d.jpg", &[gps_date.clone(), gps_ts((15, 1))]);
        assert_eq!(t, (Some(utc), false));
        // Saat farkı varsa GPS'e bakılmaz.
        let t = time_of(
            &dir,
            "e.jpg",
            &[
                dto.clone(),
                ascii_field(Tag::OffsetTimeOriginal, "+03:00"),
                gps_date.clone(),
                gps_ts((59, 1)),
            ],
        );
        assert_eq!(t, (Some(utc), false));
        // Bozuk GPS zamanı yok sayılır.
        let t = time_of(&dir, "f.jpg", &[dto.clone(), gps_date, gps_ts((15, 0))]);
        assert_eq!(t, (Some(utc + 3 * 3_600_000), true));

        // TIFF dosyası başından okunur.
        std::fs::write(dir.join("g.tif"), tiff(&[dto])).unwrap();
        let info = read_photo(&dir.join("g.tif")).unwrap();
        assert_eq!(info.time, Some(utc + 3 * 3_600_000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_skips_hidden_packages_and_stops_at_limit() {
        let dir = temp_dir("skip");
        for sub in [
            ".gizli",
            "Kitaplik.photoslibrary",
            "X.app",
            "$RECYCLE.BIN",
            "System Volume Information",
            "tatil",
        ] {
            std::fs::create_dir_all(dir.join(sub)).unwrap();
            std::fs::write(dir.join(sub).join("a.jpg"), b"").unwrap();
        }
        for i in 0..5 {
            std::fs::write(dir.join(format!("{i}.jpg")), b"").unwrap();
        }
        let d = dir.to_string_lossy().into_owned();
        let all = expand(std::slice::from_ref(&d));
        assert_eq!(all.len(), 6, "{all:?}");
        assert!(all.contains(&dir.join("tatil").join("a.jpg")));
        // Sınıra ulaşınca tarama durur; sıra dosya adına göredir.
        let some = expand_limited(std::slice::from_ref(&d), 2);
        assert_eq!(some, [dir.join("0.jpg"), dir.join("1.jpg")]);
        // Gizli klasör doğrudan seçilirse taranır.
        let hidden = dir.join(".gizli").to_string_lossy().into_owned();
        assert_eq!(expand(&[hidden]).len(), 1);
        assert!(is_skipped_dir("Foo.Bundle"));
        assert!(!is_skipped_dir("tatil"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn civil_time() {
        let d = exif::DateTime::from_ascii(b"1970:01:01 00:00:00").unwrap();
        assert_eq!(civil_ms(&d), Some(0));
        let d = exif::DateTime::from_ascii(b"2000:02:29 12:00:00").unwrap();
        assert_eq!(civil_ms(&d), Some(951_825_600_000));
        let d = exif::DateTime::from_ascii(b"2000:13:29 12:00:00").unwrap();
        assert_eq!(civil_ms(&d), None);
    }
}
