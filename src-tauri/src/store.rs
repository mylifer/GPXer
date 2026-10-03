//! Uygulama verisi JSON dosyalarının (bilgiler, yerler, ayarlar) güvenli
//! okunup yazılması.

use serde::de::DeserializeOwned;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Okunan değer ve dosyanın üzerine yazılıp yazılamayacağı.
pub(crate) struct Loaded<T> {
    pub value: T,
    /// Dosya var ama okunamadı (kilitli, izin yok): boş değerle başlanır,
    /// ama kaydetmek dosyadaki veriyi sileceği için kayıt reddedilir.
    pub locked: Option<String>,
}

/// JSON dosyasını okur. Dosya yoksa varsayılan değer döner. Bozuksa silinmez
/// ve üzerine yazılmaz: `<ad>.bad-<zaman>` adıyla kenara alınır. Başka bir
/// nedenle okunamıyorsa `locked` dolu döner.
pub(crate) fn load_json<T: DeserializeOwned + Default>(path: &Path, what: &str) -> Loaded<T> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Loaded {
                value: T::default(),
                locked: None,
            }
        }
        Err(e) => {
            eprintln!("{what} okunamadı ({}): {e}", path.display());
            return Loaded {
                value: T::default(),
                locked: Some(format!(
                    "{what} açılışta okunamadı ({e}); veriyi korumak için değişiklik kaydedilmiyor. Uygulamayı yeniden başlatın."
                )),
            };
        }
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => Loaded {
            value: v,
            locked: None,
        },
        Err(e) => {
            let bad = aside_name(path);
            match std::fs::rename(path, &bad) {
                Ok(()) => eprintln!("{what} bozuk ({e}); {} olarak saklandı", bad.display()),
                Err(re) => eprintln!("{what} bozuk ({e}) ve kenara alınamadı: {re}"),
            }
            Loaded {
                value: T::default(),
                locked: None,
            }
        }
    }
}

fn aside_name(path: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".bad-{stamp}"));
    path.with_file_name(name)
}

/// Dosyayı yarım kalmayacak biçimde yazar: geçici dosyaya yazıp diske
/// işler (`sync_all`), sonra yerine taşır. Elektrik kesilirse eski ya da yeni
/// içerik kalır, boş dosya kalmaz.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, path)?;
    // Taşımanın kendisi de diske işlensin (Unix'te klasör kaydı).
    #[cfg(unix)]
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gpxer-store-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn missing_file_is_empty_and_writable() {
        let d = dir("missing");
        let l: Loaded<HashMap<String, u32>> = load_json(&d.join("a.json"), "x");
        assert!(l.value.is_empty() && l.locked.is_none());
    }

    #[test]
    fn corrupt_file_is_kept_aside() {
        let d = dir("corrupt");
        let p = d.join("a.json");
        std::fs::write(&p, b"{bozuk").unwrap();
        let l: Loaded<HashMap<String, u32>> = load_json(&p, "x");
        assert!(l.value.is_empty() && l.locked.is_none());
        assert!(!p.exists());
        let aside: Vec<_> = std::fs::read_dir(&d).unwrap().flatten().collect();
        assert_eq!(aside.len(), 1);
        assert_eq!(std::fs::read(aside[0].path()).unwrap(), b"{bozuk");
    }

    #[test]
    fn unreadable_file_is_locked() {
        let d = dir("unreadable");
        // Klasör, dosya gibi okunamaz.
        let p = d.join("a.json");
        std::fs::create_dir(&p).unwrap();
        let l: Loaded<HashMap<String, u32>> = load_json(&p, "x");
        assert!(l.locked.is_some());
        assert!(p.exists());
    }

    #[test]
    fn writes_atomically() {
        let d = dir("write");
        let p = d.join("a.json");
        write_atomic(&p, b"1").unwrap();
        write_atomic(&p, b"22").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"22");
        assert!(!d.join("a.tmp").exists());
    }
}
