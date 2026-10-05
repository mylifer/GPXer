//! Harita karoları için disk önbelleği: harita bütün karoları (altlık, vektör,
//! arazi, kullanıcı katmanları) buradan ister. Önbellekte varsa oradan, yoksa
//! internetten alınıp saklanır; internet yoksa eski kopya kullanılır. Böylece
//! görülmüş ya da önceden indirilmiş bölgeler çevrimdışı da açılır.

use crate::run_blocking;
use serde::Serialize;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

/// Bu yaştan eski karolar internet varsa yenilenir.
const FRESH: Duration = Duration::from_secs(30 * 24 * 3600);
/// Önbelleğin üst sınırı; aşılınca en eski karolar silinir.
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Bu kadar yeni karoda bir sınır denetlenir (uygulama açıkken de).
const PRUNE_EVERY: usize = 3000;

pub(crate) struct TileCache {
    dir: PathBuf,
    agent: ureq::Agent,
    /// Son denetimden beri yazılan karo sayısı.
    written: std::sync::atomic::AtomicUsize,
    /// Aynı anda tek temizlik.
    pruning: std::sync::Mutex<()>,
}

impl TileCache {
    pub(crate) fn new(dir: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&dir);
        Self {
            written: Default::default(),
            pruning: Default::default(),
            dir,
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(20))
                .user_agent(concat!(
                    "GPXer/",
                    env!("CARGO_PKG_VERSION"),
                    " (masaüstü GPX görüntüleyici)"
                ))
                .build(),
        }
    }

    fn path(&self, url: &str) -> PathBuf {
        // İki farklı tohumla 128 bit: çakışma pratikte olmaz.
        let h = |seed: u64| {
            let mut s = std::collections::hash_map::DefaultHasher::new();
            seed.hash(&mut s);
            url.hash(&mut s);
            s.finish()
        };
        let name = format!("{:016x}{:016x}", h(1), h(2));
        self.dir.join(&name[..2]).join(name)
    }

    /// Önbellekteki karo ve yaşı.
    fn cached(&self, url: &str) -> Option<(Vec<u8>, Duration)> {
        let p = self.path(url);
        let age = std::fs::metadata(&p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .unwrap_or_default();
        std::fs::read(&p).ok().map(|b| (b, age))
    }

    fn store(&self, url: &str, bytes: &[u8]) {
        let p = self.path(url);
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = crate::store::write_atomic(&p, bytes);
        let n = self
            .written
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if n % PRUNE_EVERY == PRUNE_EVERY - 1 {
            self.prune();
        }
    }

    fn download(&self, url: &str) -> Result<Vec<u8>, String> {
        let resp = self.agent.get(url).call().map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("{code}"),
            ureq::Error::Transport(t) => t.to_string(),
        })?;
        let mut buf = Vec::new();
        use std::io::Read;
        const MAX: u64 = 20 * 1024 * 1024;
        resp.into_reader()
            .take(MAX + 1)
            .read_to_end(&mut buf)
            .map_err(|e| e.to_string())?;
        // Kesik yanıt önbelleğe girmesin.
        if buf.len() as u64 > MAX {
            return Err("Karo çok büyük".into());
        }
        Ok(buf)
    }

    /// Önbellek önce; eskiyse yenilenir, internet yoksa eski kopya.
    pub(crate) fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("Geçersiz karo adresi".into());
        }
        let cached = self.cached(url);
        let out = match &cached {
            Some((b, age)) if *age < FRESH => Ok(b.clone()),
            _ => match self.download(url) {
                Ok(b) => {
                    self.store(url, &b);
                    Ok(b)
                }
                Err(e) => cached.map(|(b, _)| b).ok_or(e),
            },
        };
        // Vektör karolardaki sokak ve yer adları çevrimdışı arama dizinine.
        if let Ok(b) = &out {
            crate::streets::index_tile(url, b);
        }
        out
    }

    /// Önbelleğin boyutu ve karo sayısı.
    fn info(&self) -> (u64, usize) {
        let mut bytes = 0;
        let mut n = 0;
        for e in walkdir::WalkDir::new(&self.dir).into_iter().flatten() {
            if e.file_type().is_file() {
                bytes += e.metadata().map_or(0, |m| m.len());
                n += 1;
            }
        }
        (bytes, n)
    }

    /// Sınır aşıldıysa en eski karoları siler.
    pub(crate) fn prune(&self) {
        // Başka bir istek zaten temizliyorsa beklemeden geçilir.
        let Ok(_guard) = self.pruning.try_lock() else {
            return;
        };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = walkdir::WalkDir::new(&self.dir)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((m.modified().ok()?, m.len(), e.into_path()))
            })
            .collect();
        let mut total: u64 = files.iter().map(|f| f.1).sum();
        if total <= MAX_BYTES {
            return;
        }
        files.sort();
        for (_, len, p) in files {
            if total <= MAX_BYTES * 9 / 10 {
                break;
            }
            if std::fs::remove_file(&p).is_ok() {
                total -= len;
            }
        }
    }
}

/// Haritanın istediği karo (ham bayt).
#[tauri::command]
pub(crate) async fn tile(app: AppHandle, url: String) -> Result<tauri::ipc::Response, String> {
    run_blocking(move || {
        app.state::<TileCache>()
            .get(&url)
            .map(tauri::ipc::Response::new)
    })
    .await?
}

/// Verilen karoları önbelleğe indirir; indirilen (ya da zaten olan) sayısı.
#[tauri::command]
pub(crate) async fn prefetch_tiles(app: AppHandle, urls: Vec<String>) -> Result<usize, String> {
    if urls.len() > 500 {
        return Err("Bir seferde en çok 500 karo".into());
    }
    run_blocking(move || {
        use rayon::prelude::*;
        let cache = app.state::<TileCache>();
        // Sunuculara yük olmasın: az sayıda eşzamanlı istek.
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(pool.install(|| urls.par_iter().filter(|u| cache.get(u).is_ok()).count()))
    })
    .await?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TileCacheInfo {
    bytes: u64,
    count: usize,
}

#[tauri::command]
pub(crate) async fn tile_cache_info(app: AppHandle) -> Result<TileCacheInfo, String> {
    run_blocking(move || {
        let (bytes, count) = app.state::<TileCache>().info();
        TileCacheInfo { bytes, count }
    })
    .await
}

#[tauri::command]
pub(crate) async fn clear_tile_cache(app: AppHandle) -> Result<(), String> {
    run_blocking(move || {
        let dir = app.state::<TileCache>().dir.clone();
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    fn caches_and_serves_stale_when_offline() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            // Yalnızca tek istek yanıtlanır; sonra sunucu kapanır (çevrimdışı).
            let mut s = listener.incoming().next().unwrap().unwrap();
            let mut line = String::new();
            BufReader::new(&s).read_line(&mut line).unwrap();
            write!(
                s,
                "HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nPNG!"
            )
            .unwrap();
        });
        let dir = std::env::temp_dir().join(format!("gpxer-tiles-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let c = TileCache::new(dir.clone());
        let url = format!("http://{addr}/1/2/3.png");
        assert_eq!(c.get(&url).unwrap(), b"PNG!");
        // Sunucu yok: önbellekten gelir.
        assert_eq!(c.get(&url).unwrap(), b"PNG!");
        // Eskimiş olsa bile internet yoksa eski kopya.
        let p = c.path(&url);
        let old = SystemTime::now() - Duration::from_secs(60 * 24 * 3600);
        std::fs::File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(c.get(&url).unwrap(), b"PNG!");
        assert!(c.get("file:///etc/passwd").is_err());
        assert_eq!(c.info().1, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
