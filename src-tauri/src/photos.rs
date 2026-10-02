//! Fotoğrafların EXIF bilgileri: çekim zamanı, GPS konumu ve gömülü küçük
//! resim. Fotoğraflar kütüphaneye kopyalanmaz; yalnızca okunur.

use base64::Engine;
use exif::{In, Tag, Value};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Bir seferde okunan en fazla fotoğraf sayısı.
pub const MAX_PHOTOS: usize = 5000;
/// Gömülü küçük resim bundan büyükse alınmaz (bozuk EXIF'e karşı).
const MAX_THUMB_BYTES: usize = 256 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PhotoInfo {
    pub path: String,
    pub name: String,
    /// Çekim zamanı (Unix ms).
    pub time: Option<i64>,
    /// EXIF'te saat farkı (OffsetTimeOriginal) yoksa `true`: zaman, yerel
    /// saat UTC'ymiş gibi hesaplanmıştır; arayüz kaydın saat dilimine göre
    /// düzeltir.
    pub time_is_local: bool,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    /// Gömülü küçük resim (`data:image/jpeg;base64,…`).
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

/// Dosya ve klasörlerden (özyinelemeli) fotoğraf yolları; tekilleştirilmiş,
/// en fazla [`MAX_PHOTOS`] tane. Doğrudan verilen dosyalar uzantıya
/// bakılmadan alınır.
pub fn expand(paths: &[String]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for p in paths {
        let path = PathBuf::from(p);
        let found: Vec<PathBuf> = if path.is_dir() {
            let mut v: Vec<PathBuf> = walkdir::WalkDir::new(&path)
                .follow_links(true)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_file() && is_photo(e.path()))
                .map(|e| e.into_path())
                .collect();
            v.sort();
            v
        } else if path.is_file() {
            vec![path]
        } else {
            Vec::new()
        };
        for f in found {
            if out.len() >= MAX_PHOTOS {
                return out;
            }
            if seen.insert(f.clone()) {
                out.push(f);
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

pub fn read_photo(path: &Path) -> Option<PhotoInfo> {
    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
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
    let mut reader = std::io::BufReader::new(file);
    let Ok(exif) = exif::Reader::new().read_from_container(&mut reader) else {
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
    info.thumb = thumbnail(&exif).map(|b| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(b)
        )
    });
    Some(info)
}

fn ascii(exif: &exif::Exif, tag: Tag) -> Option<&[u8]> {
    match &exif.get_field(tag, In::PRIMARY)?.value {
        Value::Ascii(v) => v.first().map(Vec::as_slice),
        _ => None,
    }
}

/// Çekim zamanı (Unix ms) ve saat farkının bilinmediği (yerel saat) mi.
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
    sources.iter().find_map(|&(dt, off, sub)| {
        let mut d = exif::DateTime::from_ascii(ascii(exif, dt)?).ok()?;
        if let Some(s) = ascii(exif, sub) {
            let _ = d.parse_subsec(s);
        }
        if let Some(o) = ascii(exif, off) {
            let _ = d.parse_offset(o);
        }
        let local = civil_ms(&d)?;
        Some(match d.offset {
            Some(min) => (local - i64::from(min) * 60_000, false),
            None => (local, true),
        })
    })
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
        assert_eq!(a.thumb.as_deref(), Some("data:image/jpeg;base64,/9j/2Q=="));

        let b = &photos[1];
        assert_eq!(b.time, Some(1_714_555_815_000));
        assert!(b.time_is_local);
        assert_eq!((b.lat, b.lon, b.thumb.as_deref()), (None, None, None));

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
