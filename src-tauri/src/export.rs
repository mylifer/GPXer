//! Kaydetme penceresi, yazma izinleri ve dışa aktarma.

use crate::library::Library;
use crate::meta::MetaStore;
use crate::settings::SettingsStore;
use crate::{prepared, read_raw, run_blocking};
use base64::Engine;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Kaydetme penceresinde seçilen, yazılmasına izin verilmiş hedefler.
/// Her izin bir yazmada kullanılır.
#[derive(Default)]
pub(crate) struct ApprovedPaths(Mutex<HashSet<String>>);

#[derive(Deserialize)]
pub(crate) struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// Kaydetme penceresini açar; seçilen yolu yazma izni verilmiş olarak
/// kaydedip döndürür. Vazgeçilirse `None`.
#[tauri::command]
pub(crate) async fn pick_save_path(
    app: AppHandle,
    default_name: String,
    filters: Vec<DialogFilter>,
) -> Result<Option<String>, String> {
    run_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file().set_file_name(&default_name);
        if let Some(w) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&w);
        }
        for f in &filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            dialog = dialog.add_filter(&f.name, &exts);
        }
        let path = dialog.blocking_save_file()?.into_path().ok()?;
        let path = path.to_string_lossy().into_owned();
        app.state::<ApprovedPaths>()
            .0
            .lock()
            .unwrap()
            .insert(path.clone());
        Some(path)
    })
    .await
}

/// Hedefin kaydetme penceresinde seçildiğini denetler; izni kullanır.
pub(crate) fn take_approved(app: &AppHandle, path: &str) -> Result<(), String> {
    let state = app.state::<ApprovedPaths>();
    let mut approved = state.0.lock().unwrap();
    if approved.remove(path) {
        return Ok(());
    }
    // Pencerede uzantısız bir ad seçildiyse arayüz biçimin uzantısını ekler.
    let p = Path::new(path);
    let known = ["gpx", "kml", "tcx", "fit", "csv", "png", "zip"];
    let base = p
        .extension()
        .and_then(|e| e.to_str())
        .filter(|e| known.contains(&e.to_ascii_lowercase().as_str()))
        .and_then(|_| p.with_extension("").to_str().map(str::to_owned));
    if let Some(base) = base.filter(|b| Path::new(b).extension().is_none()) {
        if approved.remove(&base) {
            return Ok(());
        }
    }
    Err("Bu konuma yazma izni yok; kaydetme yerini yeniden seçin".into())
}

/// İki yol aynı dosyayı mı gösteriyor (hedef henüz olmayabilir).
fn same_file(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| {
        p.canonicalize().ok().or_else(|| {
            let parent = p.parent()?.canonicalize().ok()?;
            Some(parent.join(p.file_name()?))
        })
    };
    match (canon(a), canon(b)) {
        (Some(x), Some(y)) => x == y,
        _ => a == b,
    }
}

/// Kütüphanedeki dosyayı seçilen yere seçilen biçimde (gpx, kml, tcx) kaydeder.
#[tauri::command]
pub(crate) async fn export_as(
    app: AppHandle,
    src: String,
    dest: String,
    format: String,
) -> Result<(), String> {
    run_blocking(move || {
        take_approved(&app, &dest)?;
        app.state::<Library>().check(&src)?;
        if same_file(Path::new(&src), Path::new(&dest)) {
            return Err("Kayıt kendi üzerine kaydedilemez; başka bir yer seçin".into());
        }
        if format == "gpx" {
            return std::fs::copy(&src, &dest)
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        let (gpx, _) = gpx_core::read_gpx_file(Path::new(&src)).map_err(|e| e.to_string())?;
        let bytes = match format.as_str() {
            "kml" => gpx_core::formats::write_kml(&gpx).into_bytes(),
            "tcx" => gpx_core::formats::write_tcx(&gpx).into_bytes(),
            "fit" => {
                // FIT'te spor türü de yazılır: seçilen ya da özetteki gibi
                // hazırlanmış (temizlenmiş) kayıttan tahmin edilen tür.
                // Yazılan veri yine ham kayıttır.
                let cfg = app.state::<SettingsStore>().stats();
                let chosen = app.state::<MetaStore>().activity(&src);
                let p = prepared(&app, &src, &cfg)?;
                let (_, activity) = gpx_core::effective_config(&p.gpx, &cfg, chosen);
                gpx_core::formats::write_fit(&gpx, activity)
            }
            other => return Err(format!("Bilinmeyen biçim: {other}")),
        };
        std::fs::write(&dest, bytes).map_err(|e| e.to_string())
    })
    .await?
}

/// Kütüphanedeki kayıtları (ham halleriyle) başlangıç zamanına göre
/// sıralayıp tek bir izde birleştirir; her kayıt kendi segment(ler)ini korur.
/// Kütüphaneye eklenmez, seçilen yere seçilen biçimde yazılır.
fn merge_for_export(parts: Vec<gpx_core::parse::Gpx>) -> gpx_core::parse::Gpx {
    let name = format!("GPXer – {} kayıt", parts.len());
    let mut merged = gpx_core::ops::merge(parts, Some(name.clone()));
    let segments = std::mem::take(&mut merged.tracks)
        .into_iter()
        .flat_map(|t| t.segments)
        .collect();
    merged.tracks = vec![gpx_core::parse::Track {
        name: Some(name),
        segments,
    }];
    merged
}

/// Seçilen kayıtları tek dosyada birleştirip seçilen yere seçilen biçimde
/// (gpx, kml, tcx, fit) kaydeder.
#[tauri::command]
pub(crate) async fn export_many(
    app: AppHandle,
    paths: Vec<String>,
    dest: String,
    format: String,
) -> Result<(), String> {
    run_blocking(move || {
        if !["gpx", "kml", "tcx", "fit"].contains(&format.as_str()) {
            return Err(format!("Bilinmeyen biçim: {format}"));
        }
        if paths.is_empty() {
            return Err("Dışa aktarılacak kayıt yok".into());
        }
        let library = app.state::<Library>();
        for p in &paths {
            library.check(p)?;
        }
        take_approved(&app, &dest)?;
        if paths
            .iter()
            .any(|p| same_file(Path::new(p), Path::new(&dest)))
        {
            return Err("Kayıt kendi üzerine kaydedilemez; başka bir yer seçin".into());
        }
        // FIT'te spor türü yalnızca tüm kayıtlarda aynıysa yazılır. Tür,
        // kayıtlar yeniden özetlenmeden seçilen türden ya da önbellekteki
        // özetten alınır.
        let activity = (format == "fit").then(|| {
            let meta = app.state::<MetaStore>();
            let kinds: Vec<gpx_core::Activity> = paths
                .iter()
                .map(|p| {
                    meta.activity(p)
                        .or_else(|| library.cached_activity(p))
                        .unwrap_or_default()
                })
                .collect();
            common_activity(&kinds)
        });
        let parts = paths
            .iter()
            .map(|p| read_raw(&app, p))
            .collect::<Result<Vec<_>, _>>()?;
        // Parçalar birleştirilirken taşınır (kopyalanmaz).
        let merged = merge_for_export(parts);
        write_export(&merged, &format, activity, Path::new(&dest))
    })
    .await?
}

/// Tüm türler aynıysa o tür, değilse bilinmiyor.
fn common_activity(kinds: &[gpx_core::Activity]) -> gpx_core::Activity {
    match kinds.first() {
        Some(&first) if kinds.iter().all(|k| *k == first) => first,
        _ => gpx_core::Activity::Unknown,
    }
}

/// Birleştirilmiş kaydı hedefe yazar. Metin biçimleri bellekte tamamı
/// oluşturulmadan akış halinde yazılır; FIT baytları bir kez oluşturulup
/// doğrudan yazılır.
fn write_export(
    gpx: &gpx_core::parse::Gpx,
    format: &str,
    activity: Option<gpx_core::Activity>,
    dest: &Path,
) -> Result<(), String> {
    use std::io::Write;
    let file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut w = std::io::BufWriter::new(file);
    let res = match format {
        "gpx" => gpx_core::write::write_gpx_to(gpx, &mut w),
        "kml" => gpx_core::formats::write_kml_to(gpx, &mut w),
        "tcx" => gpx_core::formats::write_tcx_to(gpx, &mut w),
        "fit" => {
            let bytes = gpx_core::formats::write_fit(gpx, activity.unwrap_or_default());
            w.write_all(&bytes).and_then(|_| w.flush())
        }
        other => Err(std::io::Error::other(format!("Bilinmeyen biçim: {other}"))),
    };
    let res = res.and_then(|_| w.into_inner().map_err(|e| e.into_error())?.sync_all());
    if let Err(e) = res {
        // Yarım dosya bırakılmaz.
        let _ = std::fs::remove_file(dest);
        return Err(e.to_string());
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn write_text_file(
    app: AppHandle,
    path: String,
    contents: String,
) -> Result<(), String> {
    run_blocking(move || {
        take_approved(&app, &path)?;
        std::fs::write(&path, contents).map_err(|e| e.to_string())
    })
    .await?
}

/// Base64 ile gelen ikili veriyi (ör. PNG) dosyaya yazar.
#[tauri::command]
pub(crate) async fn write_base64_file(
    app: AppHandle,
    path: String,
    data: String,
) -> Result<(), String> {
    run_blocking(move || {
        take_approved(&app, &path)?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())
    })
    .await?
}
#[cfg(test)]
mod tests {
    use super::*;

    fn gpx(text: &str) -> gpx_core::parse::Gpx {
        gpx_core::parse_gpx(text.as_bytes()).unwrap()
    }

    #[test]
    fn export_merge_keeps_sources_as_segments() {
        let late = gpx(
            r#"<gpx><trk><trkseg><trkpt lat="41" lon="29"><time>2024-05-02T06:00:00Z</time></trkpt><trkpt lat="41.01" lon="29"><time>2024-05-02T06:01:00Z</time></trkpt></trkseg></trk></gpx>"#,
        );
        let early = gpx(
            r#"<gpx><trk><trkseg><trkpt lat="40" lon="29"><time>2024-05-01T06:00:00Z</time></trkpt></trkseg><trkseg><trkpt lat="40.1" lon="29"><time>2024-05-01T07:00:00Z</time></trkpt></trkseg></trk></gpx>"#,
        );
        let m = merge_for_export(vec![late, early]);
        assert_eq!(m.name.as_deref(), Some("GPXer – 2 kayıt"));
        assert_eq!(m.tracks.len(), 1);
        assert_eq!(m.tracks[0].name.as_deref(), Some("GPXer – 2 kayıt"));
        let firsts: Vec<f64> = m.tracks[0].segments.iter().map(|s| s[0].lat).collect();
        // Başlangıç zamanına göre sıralı; kaynakların segmentleri korunur.
        assert_eq!(firsts, [40.0, 40.1, 41.0]);
        let text = gpx_core::write::write_gpx(&m);
        assert_eq!(text.matches("<trkseg>").count(), 3);
        assert!(!gpx_core::formats::write_fit(&m, gpx_core::Activity::Unknown).is_empty());
    }

    #[test]
    fn export_streams_to_file_and_picks_activity() {
        use gpx_core::Activity;
        let dir = std::env::temp_dir().join(format!("gpxer-export-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = r#"<gpx><trk><trkseg><trkpt lat="41" lon="29"><time>2024-05-02T06:00:00Z</time></trkpt><trkpt lat="41.01" lon="29"><time>2024-05-02T06:01:00Z</time></trkpt></trkseg></trk></gpx>"#;
        let m = merge_for_export(vec![gpx(src), gpx(src)]);
        for f in ["gpx", "kml", "tcx", "fit"] {
            let dest = dir.join(format!("out.{f}"));
            write_export(&m, f, Some(Activity::Walk), &dest).unwrap();
            let bytes = std::fs::read(&dest).unwrap();
            let expected = match f {
                "gpx" => gpx_core::write::write_gpx(&m).into_bytes(),
                "kml" => gpx_core::formats::write_kml(&m).into_bytes(),
                "tcx" => gpx_core::formats::write_tcx(&m).into_bytes(),
                _ => gpx_core::formats::write_fit(&m, Activity::Walk),
            };
            assert_eq!(bytes, expected, "{f}");
        }
        let bad = dir.join("out.xyz");
        assert!(write_export(&m, "xyz", None, &bad).is_err());
        assert!(!bad.exists());
        assert_eq!(
            common_activity(&[Activity::Bike, Activity::Bike]),
            Activity::Bike
        );
        assert_eq!(
            common_activity(&[Activity::Bike, Activity::Run]),
            Activity::Unknown
        );
        assert_eq!(common_activity(&[]), Activity::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
