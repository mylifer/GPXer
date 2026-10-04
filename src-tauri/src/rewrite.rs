//! Kütüphanedeki bir kaydı yerinde değiştiren işlemler (yükseklik düzeltme,
//! yola oturtma) için ortak yol: önceki hal çöp kutusu klasöründe saklanır,
//! özet yeniden hesaplanır ve işlem geri alınabilir.

use crate::library::{Library, LoadResult};
use crate::meta::MetaStore;
use crate::run_blocking;
use crate::settings::SettingsStore;
use gpx_core::parse::Gpx;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RewriteResult {
    result: LoadResult,
    /// Geri almak için saklanan önceki hal.
    previous: String,
    /// Değişiklikten önceki özet (önce/sonra karşılaştırması için).
    before: Option<gpx_core::stats::Stats>,
}

/// Kaydı okuyup `change` ile değiştirir ve yerine yazar.
pub(crate) fn rewrite_record(
    app: &AppHandle,
    path: &str,
    change: impl FnOnce(&mut Gpx) -> Result<(), String>,
) -> Result<RewriteResult, String> {
    let library = app.state::<Library>();
    library.check(path)?;
    let cfg = app.state::<SettingsStore>().stats();
    let chosen = app.state::<MetaStore>().activity(path);
    let before = library
        .summarize(path, &cfg, chosen)
        .ok()
        .map(|(s, _)| s.stats);
    let (mut gpx, _) = gpx_core::read_gpx_file(path.as_ref()).map_err(|e| e.to_string())?;
    change(&mut gpx)?;
    let previous = library.keep_previous(path)?;
    let text = gpx_core::write::write_gpx(&gpx);
    if let Err(e) = crate::store::write_atomic(path.as_ref(), text.as_bytes()) {
        let _ = std::fs::remove_file(&previous);
        return Err(format!("Kayıt yazılamadı: {e}"));
    }
    let result = library.load(path.to_owned(), &cfg, chosen);
    let _ = library.flush_cache();
    Ok(RewriteResult {
        result,
        previous,
        before,
    })
}

/// [`rewrite_record`] ile yapılan değişikliği geri alır.
#[tauri::command]
pub(crate) async fn undo_rewrite(
    app: AppHandle,
    path: String,
    previous: String,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let library = app.state::<Library>();
        library.put_back(&path, &previous)?;
        let cfg = app.state::<SettingsStore>().stats();
        let chosen = app.state::<MetaStore>().activity(&path);
        let result = library.load(path, &cfg, chosen);
        let _ = library.flush_cache();
        Ok(result)
    })
    .await?
}
