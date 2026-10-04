//! Kırpma, bölme ve birleştirme: sonuçlar yeni kayıt olarak kütüphaneye eklenir.

use crate::library::{Library, LoadResult};
use crate::meta::{FileMeta, MetaStore};
use crate::settings::SettingsStore;
use crate::{prepared, raw_index, read_raw, run_blocking};
use tauri::{AppHandle, Manager};

/// Yeni oluşturulan kaydı kütüphaneye yazıp özetler; kaynağın türü ve
/// etiketleri yeni kayda geçer. İçeriği kütüphanede zaten varsa yazılan
/// dosya silinir.
fn store_new(
    app: &AppHandle,
    gpx: &gpx_core::parse::Gpx,
    fallback: &str,
    inherit: &FileMeta,
) -> LoadResult {
    let library = app.state::<Library>();
    let cfg = app.state::<SettingsStore>().stats();
    let name = gpx.name.clone().unwrap_or_else(|| fallback.to_owned());
    let p = match library.write_new(&name, &gpx_core::write::write_gpx(gpx)) {
        Ok(p) => p,
        Err(e) => {
            return LoadResult::Error {
                path: name,
                message: format!("Kaydedilemedi: {e}"),
            }
        }
    };
    let path = p.to_string_lossy().into_owned();
    let meta = FileMeta {
        tags: inherit.tags.clone(),
        note: String::new(),
        activity: inherit.activity,
    };
    if meta != FileMeta::default() {
        if let Err(e) = app.state::<MetaStore>().set(&path, meta) {
            eprintln!("Kayıt bilgileri kopyalanamadı: {e}");
        }
    }
    let res = library.load(path.clone(), &cfg, inherit.activity);
    if !matches!(res, LoadResult::Ok { .. }) {
        let _ = std::fs::remove_file(&p);
        let _ = app.state::<MetaStore>().set(&path, FileMeta::default());
    }
    res
}
/// Seçilen aralığı yeni bir kayıt olarak kütüphaneye ekler. Aralık grafikteki
/// (hazırlanmış) sıralarla gelir; ham dosyadan kesilir.
#[tauri::command]
pub(crate) async fn trim_file(
    app: AppHandle,
    path: String,
    start: usize,
    end: usize,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let cfg = app.state::<SettingsStore>().stats();
        let p = prepared(&app, &path, &cfg)?;
        if p.is_empty() || start > end || start >= p.len() {
            return Err("Geçersiz aralık".into());
        }
        let (a, b) = (raw_index(&p, start)?, raw_index(&p, end.min(p.len() - 1))?);
        let raw = read_raw(&app, &path)?;
        let out = gpx_core::ops::trim(&raw, a, b).ok_or("Geçersiz aralık")?;
        let meta = app.state::<MetaStore>().get(&path);
        Ok(store_new(&app, &out, "Kırpılmış iz", &meta))
    })
    .await?
}

/// Kaydı `at` noktasından ikiye bölüp iki yeni kayıt olarak ekler.
#[tauri::command]
pub(crate) async fn split_file(
    app: AppHandle,
    path: String,
    at: usize,
) -> Result<Vec<LoadResult>, String> {
    run_blocking(move || {
        let cfg = app.state::<SettingsStore>().stats();
        let p = prepared(&app, &path, &cfg)?;
        let at = raw_index(&p, at)?;
        let raw = read_raw(&app, &path)?;
        let (a, b) = gpx_core::ops::split(&raw, at).ok_or("Bu noktadan bölünemez")?;
        let meta = app.state::<MetaStore>().get(&path);
        Ok(vec![
            store_new(&app, &a, "1. kısım", &meta),
            store_new(&app, &b, "2. kısım", &meta),
        ])
    })
    .await?
}

/// Kayıtları (ham halleriyle) tek dosyada birleştirip kütüphaneye ekler.
/// Etiketler birleşir; tür hepsinde aynıysa korunur.
#[tauri::command]
pub(crate) async fn merge_files(
    app: AppHandle,
    paths: Vec<String>,
    name: String,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let parts = paths
            .iter()
            .map(|p| read_raw(&app, p))
            .collect::<Result<Vec<_>, _>>()?;
        let store = app.state::<MetaStore>();
        let metas: Vec<FileMeta> = paths.iter().map(|p| store.get(p)).collect();
        let first = metas.first().and_then(|m| m.activity);
        let inherit = FileMeta {
            tags: metas.iter().flat_map(|m| m.tags.clone()).collect(),
            note: String::new(),
            activity: first.filter(|_| metas.iter().all(|m| m.activity == first)),
        };
        let merged = gpx_core::ops::merge(parts, Some(name.clone()));
        Ok(store_new(&app, &merged, &name, &inherit))
    })
    .await?
}

/// Arayüzün oluşturduğu GPX metnini (ör. fotoğraflardan iz) yeni kayıt olarak ekler.
#[tauri::command]
pub(crate) async fn add_gpx_record(
    app: AppHandle,
    name: String,
    gpx: String,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let parsed = gpx_core::parse::parse_gpx(gpx.as_bytes()).map_err(|e| e.to_string())?;
        Ok(store_new(&app, &parsed, &name, &FileMeta::default()))
    })
    .await?
}

/// Konumun saat dilimi (IANA adı); EXIF'teki dilimsiz saatleri çevirmek için.
#[tauri::command]
pub(crate) fn time_zone_at(lon: f64, lat: f64) -> Option<String> {
    crate::geo::time_zone_at(lon, lat)
}
