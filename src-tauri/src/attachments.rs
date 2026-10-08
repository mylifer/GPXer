//! Kayıtlara iliştirilen belgeler (bilet, otel faturası, müze girişi, ses
//! kaydı…). Dosyalar uygulama verisindeki `ekler` klasörüne kopyalanır; kayıt
//! bilgilerinde (`FileMeta::attachments`) yalnızca bu klasördeki adları
//! tutulur. Yedeğe ve açık arşive dahildir.

use crate::meta::{FileMeta, MetaStore};
use crate::run_blocking;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// Tek bir ekin üst sınırı.
const MAX_BYTES: u64 = 500 * 1024 * 1024;

/// Eklerin klasörü.
pub(crate) struct Attachments(pub PathBuf);

impl Attachments {
    pub(crate) fn open(root: &Path) -> Self {
        Attachments(root.join("ekler"))
    }

    /// Klasördeki bir ekin yolu; ad düz dosya adı değilse (klasör dışına
    /// çıkmaya çalışan) `None`.
    pub(crate) fn path_of(&self, name: &str) -> Option<PathBuf> {
        let base = Path::new(name).file_name()?.to_str()?;
        (base == name && !name.starts_with('.')).then(|| self.0.join(name))
    }

    /// Dosyayı klasöre kopyalar: "<zaman>-<ad>" (aynı adlı ekler çakışmasın).
    pub(crate) fn add(&self, src: &Path, stamp: i64) -> Result<String, String> {
        let meta = std::fs::metadata(src).map_err(|e| format!("{}: {e}", src.display()))?;
        if !meta.is_file() {
            return Err(format!("{} bir dosya değil", src.display()));
        }
        if meta.len() > MAX_BYTES {
            return Err(format!("{} çok büyük (en fazla 500 MB)", src.display()));
        }
        let base: String = src
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "ek".into())
            .chars()
            .map(|c| match c {
                '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
                c if c.is_control() => '_',
                c => c,
            })
            .collect();
        std::fs::create_dir_all(&self.0).map_err(|e| e.to_string())?;
        // Aynı ad varsa zaman damgası bir artırılır.
        let mut t = stamp;
        loop {
            let name = format!("{t}-{base}");
            let dest = self.0.join(&name);
            if !dest.exists() {
                std::fs::copy(src, &dest).map_err(|e| format!("{}: {e}", src.display()))?;
                return Ok(name);
            }
            t += 1;
        }
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Ekin kullanıcıya gösterilen adı ("1720…-bilet.pdf" → "bilet.pdf").
#[cfg(test)]
fn display_name(name: &str) -> &str {
    name.split_once('-').map_or(name, |(_, r)| r)
}

/// Dosyaları kayda iliştirir; kaydın yeni bilgilerini döndürür.
#[tauri::command]
pub(crate) async fn attach_files(
    app: AppHandle,
    path: String,
    files: Vec<String>,
) -> Result<FileMeta, String> {
    run_blocking(move || {
        let dir = app.state::<Attachments>();
        let store = app.state::<MetaStore>();
        let mut meta = store.get(&path);
        let stamp = now_ms();
        let mut errors = Vec::new();
        for f in &files {
            match dir.add(Path::new(f), stamp) {
                Ok(name) => meta.attachments.push(name),
                Err(e) => errors.push(e),
            }
        }
        store
            .set(&path, meta.clone())
            .map_err(|e| format!("Kayıt bilgileri yazılamadı: {e}"))?;
        if !errors.is_empty() && meta.attachments.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(meta)
    })
    .await?
}

/// Eki varsayılan uygulamayla açar.
#[tauri::command]
pub(crate) fn open_attachment(app: AppHandle, name: String) -> Result<(), String> {
    let p = app
        .state::<Attachments>()
        .path_of(&name)
        .filter(|p| p.is_file())
        .ok_or("Ek bu bilgisayarda bulunamadı (başka cihazda eklenmiş olabilir)")?;
    app.opener()
        .open_path(p.to_string_lossy(), None::<&str>)
        .map_err(|e| format!("Ek açılamadı: {e}"))
}

/// Eki kayıttan kaldırır; başka kayıt kullanmıyorsa dosyası da silinir.
#[tauri::command]
pub(crate) async fn remove_attachment(
    app: AppHandle,
    path: String,
    name: String,
) -> Result<FileMeta, String> {
    run_blocking(move || {
        let store = app.state::<MetaStore>();
        let mut meta = store.get(&path);
        meta.attachments.retain(|a| *a != name);
        store
            .set(&path, meta.clone())
            .map_err(|e| format!("Kayıt bilgileri yazılamadı: {e}"))?;
        let used = store.all().values().any(|m| m.attachments.contains(&name));
        if !used {
            if let Some(p) = app.state::<Attachments>().path_of(&name) {
                let _ = std::fs::remove_file(p);
            }
        }
        Ok(meta)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_and_names_attachments() {
        let root = std::env::temp_dir().join(format!("gpxer-ekler-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("bilet.pdf");
        std::fs::write(&src, b"%PDF").unwrap();
        let a = Attachments::open(&root);
        let n1 = a.add(&src, 1000).unwrap();
        let n2 = a.add(&src, 1000).unwrap();
        assert_eq!(n1, "1000-bilet.pdf");
        assert_eq!(n2, "1001-bilet.pdf");
        assert_eq!(display_name(&n1), "bilet.pdf");
        assert_eq!(display_name(&n2), "bilet.pdf");
        assert_eq!(std::fs::read(a.path_of(&n2).unwrap()).unwrap(), b"%PDF");
        assert!(a.path_of("../meta.json").is_none());
        assert!(a.path_of("..").is_none());
        assert!(a.add(&root, 1).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
