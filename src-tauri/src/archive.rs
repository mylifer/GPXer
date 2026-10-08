//! Hesap dışa aktarma arşivlerinden (Strava, Garmin Connect, Google Takeout)
//! içe aktarma: zip içindeki iz dosyaları (sıkıştırılmış `.gz` ve iç içe zip
//! dahil) geçici klasöre açılıp normal açma yolundan geçer. Strava'nın
//! `activities.csv` dosyasındaki etkinlik türü kayıtlara aktarılır.

use crate::library::{Library, LoadResult};
use crate::meta::{FileMeta, MetaStore};
use crate::settings::SettingsStore;
use crate::{load_many, run_blocking};
use gpx_core::analysis::Activity;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// İç içe zip'lerde en çok bu kadar derine inilir.
const MAX_DEPTH: usize = 3;
/// Açılan tek bir dosyanın (iz, iç zip, csv) üst sınırı: zip bombasına karşı.
const MAX_ENTRY: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveImport {
    results: Vec<LoadResult>,
    /// Arşivin kaynağı (ör. "Strava"), bilinmiyorsa boş.
    source: String,
    /// Türü arşivden alınan kayıt sayısı.
    typed: usize,
    /// Açılamayan (bozuk, çok büyük) arşiv girdisi sayısı.
    skipped: usize,
}

/// Dosya adı (uzantı .gz ise onsuz) desteklenen bir iz dosyası mı.
/// Arşivdeki yolun yalnızca son parçası alınır (`/` ve `\\` ayırıcı), Windows'ta
/// geçersiz karakterler değiştirilir: girdi adı geçici klasörün dışına çıkamaz.
fn track_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let plain = base.strip_suffix(".gz").unwrap_or(base);
    let safe: String = plain
        .chars()
        .map(|c| match c {
            ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let safe = safe.trim_start_matches('.').trim_end_matches([' ', '.']);
    (!safe.is_empty() && crate::library::is_track_file(Path::new(safe))).then(|| safe.to_owned())
}

struct Extracted {
    /// (geçici yol, arşivdeki yol)
    files: Vec<(PathBuf, String)>,
    /// Strava activities.csv: dosya yolu (arşivdeki) → tür.
    types: HashMap<String, Activity>,
    source: String,
    skipped: usize,
}

/// Her dosya kendi numaralı klasörüne: aynı adlı dosyalar çakışmaz, kütüphanedeki
/// kayıt adı arşivdeki dosya adıyla aynı kalır.
fn unique(dir: &Path, name: &str, n: &mut usize) -> Result<PathBuf, String> {
    *n += 1;
    let sub = dir.join(format!("{:05}", n));
    std::fs::create_dir_all(&sub).map_err(|e| e.to_string())?;
    Ok(sub.join(name))
}

/// `r`'yi `w`'ye en çok MAX_ENTRY bayt kopyalar; sınır aşılırsa hata.
fn copy_capped(r: &mut impl Read, w: &mut impl std::io::Write) -> std::io::Result<()> {
    let n = std::io::copy(&mut r.take(MAX_ENTRY + 1), w)?;
    if n > MAX_ENTRY {
        return Err(std::io::Error::other("dosya çok büyük"));
    }
    Ok(())
}

fn extract_from<R: Read + Seek>(
    zip: &mut zip::ZipArchive<R>,
    dir: &Path,
    depth: usize,
    out: &mut Extracted,
    n: &mut usize,
) -> Result<(), String> {
    for i in 0..zip.len() {
        let Ok(mut f) = zip.by_index(i) else {
            out.skipped += 1;
            continue;
        };
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_owned();
        let lower = name.to_ascii_lowercase();
        if lower.ends_with("activities.csv") {
            let mut s = String::new();
            if (&mut f)
                .take(64 * 1024 * 1024)
                .read_to_string(&mut s)
                .is_ok()
            {
                out.types.extend(strava_types(&s));
                out.source = "Strava".into();
            }
        } else if lower.ends_with(".zip") && depth < MAX_DEPTH {
            // İç zip (Garmin'de birkaç GB olabilir) belleğe değil diske açılır.
            *n += 1;
            let path = dir.join(format!("{:05}.zip", n));
            let opened = std::fs::File::create(&path)
                .and_then(|mut w| copy_capped(&mut f, &mut w))
                .and_then(|_| std::fs::File::open(&path));
            match opened.ok().and_then(|file| zip::ZipArchive::new(file).ok()) {
                Some(mut inner) => {
                    if out.source.is_empty()
                        && (lower.contains("di_connect") || lower.contains("uploadedfiles"))
                    {
                        out.source = "Garmin Connect".into();
                    }
                    extract_from(&mut inner, dir, depth + 1, out, n)?;
                }
                None => out.skipped += 1,
            }
            let _ = std::fs::remove_file(&path);
        } else if let Some(plain) = track_name(&name) {
            if lower.contains("takeout") && out.source.is_empty() {
                out.source = "Google Takeout".into();
            }
            let target = unique(dir, &plain, n)?;
            // Bozuk bir girdi bütün içe aktarmayı durdurmaz: atlanıp sayılır.
            let ok = std::fs::File::create(&target).and_then(|mut w| {
                if lower.ends_with(".gz") {
                    copy_capped(&mut flate2::read::GzDecoder::new(&mut f), &mut w)
                } else {
                    copy_capped(&mut f, &mut w)
                }
            });
            if ok.is_ok() {
                out.files.push((target, name));
            } else {
                let _ = std::fs::remove_file(&target);
                out.skipped += 1;
            }
        }
    }
    Ok(())
}

fn extract(src: &Path, dir: &Path) -> Result<Extracted, String> {
    let file = std::fs::File::open(src).map_err(|e| format!("Arşiv açılamadı: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|_| "Bu dosya bir zip arşivi değil".to_string())?;
    if zip.by_name("gpxer-yedek.json").is_ok() {
        return Err(
            "Bu bir GPXer yedeği; Ayarlar → Yedekleme → “Yedekten geri yükle…” ile açın".into(),
        );
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut out = Extracted {
        files: Vec::new(),
        types: HashMap::new(),
        source: String::new(),
        skipped: 0,
    };
    let mut n = 0;
    extract_from(&mut zip, dir, 0, &mut out, &mut n)?;
    if out.files.is_empty() {
        return Err("Arşivde GPX, FIT, TCX, KML ya da konum geçmişi dosyası yok".into());
    }
    Ok(out)
}

/// Basit CSV satır ayırıcı (tırnaklı alanlar, içte çift tırnak).
fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match (c, quoted) {
            ('"', true) if chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            ('"', _) => quoted = !quoted,
            (',', false) => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// Strava etkinlik türü (İngilizce ya da Türkçe dışa aktarma).
fn strava_activity(t: &str) -> Option<Activity> {
    let t = t.to_lowercase();
    if t.contains("ride") || t.contains("bisiklet") || t.contains("cycl") {
        Some(Activity::Bike)
    } else if t.contains("run") || t.contains("koşu") {
        Some(Activity::Run)
    } else if t.contains("walk") || t.contains("hike") || t.contains("yürüyüş") {
        Some(Activity::Walk)
    } else if t.contains("drive") || t.contains("car") || t.contains("araç") {
        Some(Activity::Car)
    } else {
        None
    }
}

/// activities.csv → (arşivdeki dosya yolu, tür). Satır sonu tırnak içinde
/// olabilir (çok satırlı açıklama): kayıtlar tırnak dengesine göre birleştirilir.
fn strava_types(csv: &str) -> HashMap<String, Activity> {
    let mut rows: Vec<String> = Vec::new();
    let mut buf = String::new();
    for line in csv.lines() {
        if !buf.is_empty() {
            buf.push('\n');
        }
        buf.push_str(line);
        if buf.matches('"').count().is_multiple_of(2) {
            rows.push(std::mem::take(&mut buf));
        }
    }
    let mut it = rows.into_iter();
    let Some(header) = it.next() else {
        return HashMap::new();
    };
    let h = csv_fields(&header);
    let col = |names: &[&str]| {
        h.iter()
            .position(|c| names.iter().any(|n| c.trim().eq_ignore_ascii_case(n)))
    };
    let (Some(ti), Some(fi)) = (
        col(&["Activity Type", "Etkinlik Türü", "Aktivite Türü"]),
        col(&["Filename", "Dosya Adı"]),
    ) else {
        return HashMap::new();
    };
    it.filter_map(|r| {
        let f = csv_fields(&r);
        let file = f.get(fi)?.trim().to_owned();
        let act = strava_activity(f.get(ti)?)?;
        (!file.is_empty()).then_some((file, act))
    })
    .collect()
}

/// Hesap arşivini (zip) içe aktarır.
#[tauri::command]
pub(crate) async fn import_archive(app: AppHandle, src: String) -> Result<ArchiveImport, String> {
    run_blocking(move || {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let tmp = root.join(format!(
            "arsiv-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_millis())
        ));
        let res = import_into(&app, Path::new(&src), &tmp);
        let _ = std::fs::remove_dir_all(&tmp);
        res
    })
    .await?
}

fn import_into(app: &AppHandle, src: &Path, tmp: &Path) -> Result<ArchiveImport, String> {
    let x = extract(src, tmp)?;
    // Konum geçmişi (JSON) aylara bölünüp birden çok sonuç verebilir: önce
    // diğer kayıtlar yüklenir ki sonuçlar dosyalarla sıra sıra eşleşsin.
    let is_json = |p: &Path| {
        p.extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
    };
    let (tracks, histories): (Vec<_>, Vec<_>) = x.files.iter().partition(|(p, _)| !is_json(p));
    let mut results = load_many(
        app,
        tracks
            .iter()
            .map(|(p, _)| p.to_string_lossy().into_owned())
            .collect(),
        true,
    );
    // Strava türleri: yeni eklenen kayda yazılır, özeti o türle yeniden hesaplanır.
    let mut items = Vec::new();
    for (r, (_, name)) in results.iter().zip(tracks.iter().copied()) {
        let base = name.strip_suffix(".gz").unwrap_or(name);
        let act = x.types.get(name).or_else(|| x.types.get(base)).or_else(|| {
            x.types
                .iter()
                .find(|(k, _)| name.ends_with(k.as_str()))
                .map(|(_, v)| v)
        });
        if let (LoadResult::Ok { file }, Some(&a)) = (r, act) {
            items.push((file.path.clone(), a));
        }
    }
    results.extend(load_many(
        app,
        histories
            .iter()
            .map(|(p, _)| p.to_string_lossy().into_owned())
            .collect(),
        true,
    ));
    let typed = items.len();
    if typed > 0 {
        app.state::<MetaStore>()
            .merge_many(
                items
                    .iter()
                    .map(|(p, a)| {
                        (
                            p.clone(),
                            FileMeta {
                                activity: Some(*a),
                                ..Default::default()
                            },
                        )
                    })
                    .collect(),
            )
            .map_err(|e| format!("Kayıt bilgileri yazılamadı: {e}"))?;
        let library = app.state::<Library>();
        let cfg = app.state::<SettingsStore>().stats();
        let fresh: HashMap<String, Activity> = items.into_iter().collect();
        for r in results.iter_mut() {
            if let LoadResult::Ok { file } = r {
                if let Some(&a) = fresh.get(&file.path) {
                    *r = library.load(file.path.clone(), &cfg, Some(a));
                }
            }
        }
        let _ = library.flush_cache();
    }
    Ok(ArchiveImport {
        results,
        source: x.source,
        typed,
        skipped: x.skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extracts_strava_style_archive() {
        let root = std::env::temp_dir().join(format!("gpxer-arch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let gpx = "<gpx><trk><trkseg><trkpt lat=\"41\" lon=\"29\"/></trkseg></trk></gpx>";
        // İç içe zip (Garmin benzeri) içinde bir .fit yerine .gpx.
        let mut inner = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        inner
            .start_file("c.gpx", zip::write::SimpleFileOptions::default())
            .unwrap();
        inner.write_all(gpx.as_bytes()).unwrap();
        let inner = inner.finish().unwrap().into_inner();
        let src = root.join("export.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&src).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("activities.csv", o).unwrap();
        z.write_all(
            "Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Filename\n\
             1,\"Jan 1, 2023\",\"Sabah, sürüşü\",Ride,\"çok\nsatırlı\",activities/1.gpx.gz\n\
             2,\"Jan 2, 2023\",Koşu,Run,,activities/2.gpx\n"
                .as_bytes(),
        )
        .unwrap();
        z.start_file("activities/1.gpx.gz", o).unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(gpx.as_bytes()).unwrap();
        z.write_all(&gz.finish().unwrap()).unwrap();
        z.start_file("activities/2.gpx", o).unwrap();
        z.write_all(gpx.as_bytes()).unwrap();
        z.start_file("activities/notes.txt", o).unwrap();
        z.write_all(b"x").unwrap();
        z.start_file("DI_CONNECT/UploadedFiles_0.zip", o).unwrap();
        z.write_all(&inner).unwrap();
        z.finish().unwrap();

        let x = extract(&src, &root.join("ac")).unwrap();
        assert_eq!(x.files.len(), 3);
        assert_eq!(x.source, "Strava");
        assert_eq!(x.types.get("activities/1.gpx.gz"), Some(&Activity::Bike));
        assert_eq!(x.types.get("activities/2.gpx"), Some(&Activity::Run));
        // .gz açıldı.
        let first = x
            .files
            .iter()
            .find(|(_, n)| n.ends_with("1.gpx.gz"))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&first.0).unwrap(), gpx);
        assert!(first.0.to_string_lossy().ends_with("1.gpx"));
        assert_eq!(x.skipped, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn entry_names_stay_inside_the_folder() {
        assert_eq!(track_name("a/b/c.gpx").as_deref(), Some("c.gpx"));
        assert_eq!(
            track_name("x\\..\\..\\Desktop\\route.gpx").as_deref(),
            Some("route.gpx")
        );
        assert_eq!(track_name("C:route.gpx").as_deref(), Some("C_route.gpx"));
        assert_eq!(track_name("../..").as_deref(), None);
        assert_eq!(track_name("notes.txt"), None);
    }

    #[test]
    fn bad_entry_is_skipped() {
        let root = std::env::temp_dir().join(format!("gpxer-arch2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("export.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&src).unwrap());
        let o = zip::write::SimpleFileOptions::default();
        z.start_file("a/1.gpx.gz", o).unwrap();
        z.write_all(b"not gzip").unwrap();
        z.start_file("b/1.gpx", o).unwrap();
        z.write_all(b"<gpx/>").unwrap();
        z.finish().unwrap();
        let x = extract(&src, &root.join("ac")).unwrap();
        assert_eq!(x.files.len(), 1);
        assert_eq!(x.skipped, 1);
        assert!(x.files[0].0.ends_with("1.gpx"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
