//! Kütüphane yedeği: kayıtlar, kayıt bilgileri (etiket, not, tür) ve
//! adlandırılmış yerler tek bir zip dosyasında. Geri yüklemede kayıtlar normal
//! açma yolundan geçer (kopyalar atlanır), bilgiler mevcut olanlarla
//! birleştirilir. Ayarlar (izlenen klasörler bilgisayara özgü) yedeklenmez.

use crate::bookmarks::{Bookmark, BookmarkStore};
use crate::library::{Library, LoadResult};
use crate::meta::{FileMeta, MetaStore};
use crate::places::{NamedPlace, PlacesStore};
use crate::{export, load_many, run_blocking};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use tauri::{AppHandle, Manager};

const RECORDS_DIR: &str = "kayitlar/";
const META_FILE: &str = "bilgiler.json";
const PLACES_FILE: &str = "yerler.json";
const MANIFEST_FILE: &str = "gpxer-yedek.json";
const BOOKMARKS_FILE: &str = "yer-imleri.json";

#[derive(Serialize, Deserialize)]
struct Manifest {
    app: String,
    version: String,
    created: i64,
    records: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupInfo {
    records: usize,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreInfo {
    results: Vec<LoadResult>,
    meta_merged: usize,
    places_added: usize,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Kütüphaneyi kaydetme penceresinde seçilen zip dosyasına yedekler.
#[tauri::command]
pub(crate) async fn backup_library(app: AppHandle, dest: String) -> Result<BackupInfo, String> {
    run_blocking(move || {
        export::take_approved(&app, &dest)?;
        write_backup(
            Path::new(&dest),
            &app.state::<Library>().files(),
            &app.state::<MetaStore>().all(),
            &app.state::<PlacesStore>().all(),
            &app.state::<BookmarkStore>().all(),
        )
        .map_err(|e| format!("Yedek yazılamadı: {e}"))
    })
    .await?
}

fn write_backup(
    dest: &Path,
    files: &[String],
    meta: &HashMap<String, FileMeta>,
    places: &[NamedPlace],
    bookmarks: &[Bookmark],
) -> std::io::Result<BackupInfo> {
    use zip::write::SimpleFileOptions;
    // Yarım yedek kalmasın: geçici dosyaya yazılıp yerine taşınır.
    let tmp = dest.with_extension("zip.tmp");
    let res = (|| {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&tmp)?);
        let opts =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut by_name: HashMap<String, &FileMeta> = HashMap::new();
        for f in files {
            let p = Path::new(f);
            let Some(name) = p.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            zip.start_file(format!("{RECORDS_DIR}{name}"), opts)?;
            zip.write_all(&std::fs::read(p)?)?;
            if let Some(m) = meta.get(f) {
                by_name.insert(name, m);
            }
        }
        zip.start_file(META_FILE, opts)?;
        zip.write_all(&serde_json::to_vec_pretty(&by_name).map_err(std::io::Error::other)?)?;
        zip.start_file(PLACES_FILE, opts)?;
        zip.write_all(&serde_json::to_vec_pretty(places).map_err(std::io::Error::other)?)?;
        zip.start_file(BOOKMARKS_FILE, opts)?;
        zip.write_all(&serde_json::to_vec_pretty(bookmarks).map_err(std::io::Error::other)?)?;
        let manifest = Manifest {
            app: "GPXer".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            created: now_ms(),
            records: files.len(),
        };
        zip.start_file(MANIFEST_FILE, opts)?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?)?;
        zip.finish()?.sync_all()
    })();
    if let Err(e) = res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, dest)?;
    Ok(BackupInfo {
        records: files.len(),
        bytes: std::fs::metadata(dest).map_or(0, |m| m.len()),
    })
}

/// Yedekten geri yükler. Kayıtlar kütüphaneye eklenir (zaten olanlar kopya
/// sayılır), bilgiler ve yerler mevcut olanlarla birleştirilir.
#[tauri::command]
pub(crate) async fn restore_library(app: AppHandle, src: String) -> Result<RestoreInfo, String> {
    run_blocking(move || {
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let tmp = root.join(format!("geri-yukleme-{}", now_ms()));
        let res = restore_into(&app, Path::new(&src), &tmp);
        let _ = std::fs::remove_dir_all(&tmp);
        res
    })
    .await?
}

struct Extracted {
    paths: Vec<(String, String)>,
    meta: HashMap<String, FileMeta>,
    places: Vec<NamedPlace>,
    bookmarks: Vec<Bookmark>,
}

/// Yedeği `tmp` klasörüne açar; (geçici yol, yedekteki ad) çiftleri döner.
fn extract(src: &Path, tmp: &Path) -> Result<Extracted, String> {
    let file = std::fs::File::open(src).map_err(|e| format!("Yedek açılamadı: {e}"))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|_| "Bu dosya bir GPXer yedeği değil".to_string())?;
    let read = |zip: &mut zip::ZipArchive<std::fs::File>, name: &str| -> Option<Vec<u8>> {
        let mut f = zip.by_name(name).ok()?;
        let mut b = Vec::new();
        f.read_to_end(&mut b).ok()?;
        Some(b)
    };
    let manifest: Manifest = read(&mut zip, MANIFEST_FILE)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|m: &Manifest| m.app == "GPXer")
        .ok_or("Bu dosya bir GPXer yedeği değil")?;
    let _ = manifest;
    let meta: HashMap<String, FileMeta> = read(&mut zip, META_FILE)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let places: Vec<NamedPlace> = read(&mut zip, PLACES_FILE)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let bookmarks: Vec<Bookmark> = read(&mut zip, BOOKMARKS_FILE)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| e.to_string())?;
        let Some(name) = f.name().strip_prefix(RECORDS_DIR).map(str::to_owned) else {
            continue;
        };
        // Yalnızca düz dosya adı (yedekteki yol klasör dışına çıkamaz).
        let Some(base) = Path::new(&name)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
        else {
            continue;
        };
        if base != name || !crate::library::is_gpx(Path::new(&base)) {
            continue;
        }
        let out = tmp.join(&base);
        let mut w = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut w).map_err(|e| e.to_string())?;
        paths.push((out.to_string_lossy().into_owned(), base));
    }
    Ok(Extracted {
        paths,
        meta,
        places,
        bookmarks,
    })
}

fn restore_into(app: &AppHandle, src: &Path, tmp: &Path) -> Result<RestoreInfo, String> {
    let x = extract(src, tmp)?;
    let results = load_many(app, x.paths.iter().map(|(p, _)| p.clone()).collect(), true);
    // Bilgiler yedekteki dosya adına göre (sonuçlar girişle aynı sırada): yeni
    // eklenen kayda ya da zaten kütüphanede olan aynı içeriğe taşınır.
    let mut items = Vec::new();
    for (r, (_, name)) in results.iter().zip(&x.paths) {
        let to = match r {
            LoadResult::Ok { file } => file.path.clone(),
            LoadResult::Duplicate { existing, .. } => existing.clone(),
            _ => continue,
        };
        if let Some(m) = x.meta.get(name) {
            items.push((to, m.clone()));
        }
    }
    let meta_merged = app
        .state::<MetaStore>()
        .merge_many(items)
        .map_err(|e| format!("Kayıt bilgileri yazılamadı: {e}"))?;
    let store = app.state::<PlacesStore>();
    let mut all = store.all();
    let before = all.len();
    for p in x.places {
        if !all.iter().any(|q| q.id == p.id) {
            all.push(p);
        }
    }
    let places_added = all.len() - before;
    if places_added > 0 {
        store
            .set(all)
            .map_err(|e| format!("Yerler yazılamadı: {e}"))?;
    }
    let bm = app.state::<BookmarkStore>();
    let mut marks = bm.all();
    let n = marks.len();
    for b in x.bookmarks {
        if !marks.iter().any(|m| m.id == b.id) {
            marks.push(b);
        }
    }
    if marks.len() > n {
        bm.set(marks)
            .map_err(|e| format!("Yer imleri yazılamadı: {e}"))?;
    }
    Ok(RestoreInfo {
        results,
        meta_merged,
        places_added,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_round_trips_records_meta_and_places() {
        let root = std::env::temp_dir().join(format!("gpxer-backup-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let a = root.join("a.gpx");
        std::fs::write(
            &a,
            "<gpx><trk><trkseg><trkpt lat=\"41\" lon=\"29\"/></trkseg></trk></gpx>",
        )
        .unwrap();
        let meta = HashMap::from([(
            a.to_string_lossy().into_owned(),
            FileMeta {
                tags: vec!["iş".into()],
                ..Default::default()
            },
        )]);
        let places = vec![NamedPlace {
            id: "ev".into(),
            name: "Ev".into(),
            lat: 41.0,
            lon: 29.0,
            radius_m: 150.0,
            private: false,
        }];
        let dest = root.join("yedek.zip");
        let info = write_backup(
            &dest,
            &[a.to_string_lossy().into_owned()],
            &meta,
            &places,
            &[],
        )
        .unwrap();
        assert_eq!(info.records, 1);
        assert!(!root.join("yedek.zip.tmp").exists());
        let x = extract(&dest, &root.join("ac")).unwrap();
        assert_eq!(x.paths.len(), 1);
        assert_eq!(x.paths[0].1, "a.gpx");
        assert_eq!(
            std::fs::read(&x.paths[0].0).unwrap(),
            std::fs::read(&a).unwrap()
        );
        assert_eq!(x.meta["a.gpx"].tags, vec!["iş"]);
        assert_eq!(x.places.len(), 1);
        // Yedek olmayan zip reddedilir.
        let other = root.join("baska.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&other).unwrap());
        z.start_file("x.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        z.finish().unwrap();
        assert!(extract(&other, &root.join("ac2")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
