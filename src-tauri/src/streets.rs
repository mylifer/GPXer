//! Çevrimdışı sokak ve yer araması: harita karoları (vektör altlık)
//! önbelleğe girerken ya da önbellekten okunurken içlerindeki cadde, sokak,
//! mahalle, mekân ve zirve adları bir dizine eklenir. Haritada gezilen ya da
//! "çevrimdışı için indir" ile indirilen her bölge internetsiz aranabilir.
//!
//! Dizin bellekte; diskte karo başına bir satırlık eklenen bir günlük.

use crate::mvt::Named;
use crate::run_blocking;
use crate::search::{fold, PlaceHit};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Ayrıntılı sokak adları bu düzeyden itibaren karolarda bulunur.
const MIN_ZOOM: u32 = 13;

#[derive(Serialize, Deserialize)]
struct TileLine {
    z: u32,
    x: u32,
    y: u32,
    /// [ad, tür, boylam, enlem]
    n: Vec<(String, String, f64, f64)>,
}

struct Entry {
    name: String,
    key: String,
    kind: String,
    lon: f64,
    lat: f64,
}

#[derive(Default)]
struct Index {
    loaded: bool,
    tiles: HashSet<(u32, u32, u32)>,
    entries: Vec<Entry>,
}

struct Streets {
    path: PathBuf,
    index: Mutex<Index>,
}

static STREETS: OnceLock<Streets> = OnceLock::new();

/// Dizin dosyasının yeri (uygulama açılırken bir kez).
pub(crate) fn init(root: &std::path::Path) {
    let _ = STREETS.set(Streets {
        path: root.join("sokaklar.jsonl"),
        index: Mutex::new(Index::default()),
    });
}

fn add_names(ix: &mut Index, names: Vec<(String, String, f64, f64)>) {
    for (name, kind, lon, lat) in names {
        ix.entries.push(Entry {
            key: fold(&name),
            name,
            kind,
            lon,
            lat,
        });
    }
}

/// Dizin ilk kullanımda diskten okunur.
fn load(s: &Streets, ix: &mut Index) {
    if ix.loaded {
        return;
    }
    ix.loaded = true;
    let Ok(text) = std::fs::read_to_string(&s.path) else {
        return;
    };
    for line in text.lines() {
        // Yarım kalmış satır (çökme) atlanır.
        let Ok(t) = serde_json::from_str::<TileLine>(line) else {
            continue;
        };
        if ix.tiles.insert((t.z, t.x, t.y)) {
            add_names(ix, t.n);
        }
    }
}

/// Vektör karo adresinden z/x/y (ör. …/planet/…/14/9513/6144.pbf).
fn tile_of(url: &str) -> Option<(u32, u32, u32)> {
    let path = url.split(['?', '#']).next()?;
    let stem = path
        .strip_suffix(".pbf")
        .or_else(|| path.strip_suffix(".mvt"))?;
    let mut it = stem.rsplit('/');
    let y = it.next()?.parse().ok()?;
    let x = it.next()?.parse().ok()?;
    let z = it.next()?.parse().ok()?;
    Some((z, x, y))
}

/// Karo önbelleğinden geçen her karo için çağrılır; vektör karoysa ve henüz
/// dizinde değilse adları eklenir.
pub(crate) fn index_tile(url: &str, bytes: &[u8]) {
    let Some(s) = STREETS.get() else { return };
    let Some((z, x, y)) = tile_of(url) else {
        return;
    };
    if z < MIN_ZOOM {
        return;
    }
    {
        let mut ix = s.index.lock().unwrap_or_else(|e| e.into_inner());
        load(s, &mut ix);
        if ix.tiles.contains(&(z, x, y)) {
            return;
        }
    }
    let names: Vec<(String, String, f64, f64)> = crate::mvt::names(bytes, z, x, y)
        .into_iter()
        .map(
            |Named {
                 name,
                 kind,
                 lon,
                 lat,
             }| {
                (
                    name,
                    kind,
                    (lon * 1e5).round() / 1e5,
                    (lat * 1e5).round() / 1e5,
                )
            },
        )
        .collect();
    let mut ix = s.index.lock().unwrap_or_else(|e| e.into_inner());
    if !ix.tiles.insert((z, x, y)) {
        return;
    }
    // Boş karo da işaretlenir (yeniden okunmasın).
    let line = TileLine {
        z,
        x,
        y,
        n: names.clone(),
    };
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&s.path)
    {
        if let Ok(mut b) = serde_json::to_vec(&line) {
            b.push(b'\n');
            let _ = f.write_all(&b);
        }
    }
    add_names(&mut ix, names);
}

/// Dizinde arama: ad eşleşmesine, sonra haritanın ortasına uzaklığa göre.
/// Aynı adlı, birbirine yakın parçalar (bir caddenin karolara bölünmüş
/// kısımları) tek sonuçta birleşir; kutusu bütün parçaları kapsar.
pub(crate) fn search(query: &str, center: Option<(f64, f64)>, limit: usize) -> Vec<PlaceHit> {
    let Some(s) = STREETS.get() else {
        return Vec::new();
    };
    let q = fold(query.trim());
    if q.chars().count() < 2 {
        return Vec::new();
    }
    let mut ix = s.index.lock().unwrap_or_else(|e| e.into_inner());
    load(s, &mut ix);
    let words: Vec<&str> = q.split_whitespace().collect();
    // (eşleşme sırası, uzaklık², öğe)
    let mut hits: Vec<(u8, f64, &Entry)> = Vec::new();
    for e in &ix.entries {
        let rank = if e.key == q {
            0
        } else if e.key.starts_with(&q) {
            1
        } else if words
            .iter()
            .all(|w| e.key.split([' ', '-', '.']).any(|k| k.starts_with(w)))
        {
            2
        } else {
            continue;
        };
        let d = center.map_or(0.0, |(lon, lat)| {
            let kx = (lat.to_radians()).cos();
            ((e.lon - lon) * kx).powi(2) + (e.lat - lat).powi(2)
        });
        hits.push((rank, d, e));
    }
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
    // Aynı ad + ~2 km içinde: tek sonuç.
    let mut groups: Vec<(&Entry, [f64; 4])> = Vec::new();
    for (_, _, e) in hits {
        if let Some(g) = groups.iter_mut().find(|(g, b)| {
            g.key == e.key
                && e.lon >= b[0] - 0.03
                && e.lon <= b[2] + 0.03
                && e.lat >= b[1] - 0.02
                && e.lat <= b[3] + 0.02
        }) {
            g.1 = [
                g.1[0].min(e.lon),
                g.1[1].min(e.lat),
                g.1[2].max(e.lon),
                g.1[3].max(e.lat),
            ];
            continue;
        }
        if groups.len() >= limit {
            continue;
        }
        groups.push((e, [e.lon, e.lat, e.lon, e.lat]));
    }
    groups
        .into_iter()
        .map(|(e, b)| {
            // Tür adı arayüzde (çevirisiyle) eklenir; burada yalnızca yakındaki yerleşim.
            let detail = crate::geo::place_at(e.lon, e.lat).unwrap_or_default();
            PlaceHit::new(
                e.name.clone(),
                detail,
                (b[1] + b[3]) / 2.0,
                (b[0] + b[2]) / 2.0,
                (b[2] - b[0] > 0.001 || b[3] - b[1] > 0.001).then_some(b),
                e.kind.clone(),
            )
        })
        .collect()
}

/// Dizindeki öğe ve karo sayısı (Ayarlar'da gösterilir).
pub(crate) fn stats() -> (usize, usize) {
    let Some(s) = STREETS.get() else {
        return (0, 0);
    };
    let mut ix = s.index.lock().unwrap_or_else(|e| e.into_inner());
    load(s, &mut ix);
    (ix.entries.len(), ix.tiles.len())
}

#[tauri::command]
pub(crate) async fn search_streets_offline(
    query: String,
    lat: Option<f64>,
    lon: Option<f64>,
) -> Result<Vec<PlaceHit>, String> {
    run_blocking(move || search(&query, lat.zip(lon).map(|(la, lo)| (lo, la)), 8)).await
}

#[tauri::command]
pub(crate) async fn streets_info() -> Result<(usize, usize), String> {
    run_blocking(stats).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tile_urls() {
        assert_eq!(
            tile_of("https://tiles.openfreemap.org/planet/20250101_001001_pt/14/9513/6144.pbf"),
            Some((14, 9513, 6144))
        );
        assert_eq!(tile_of("https://x/a/13/1/2.mvt?key=1"), Some((13, 1, 2)));
        assert_eq!(tile_of("https://x/a/13/1/2.png"), None);
    }

    #[test]
    fn indexes_tiles_and_searches() {
        let root = std::env::temp_dir().join(format!("gpxer-streets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        init(&root);
        let t = crate::mvt::tests::tile(
            "transportation_name",
            &[
                ("Bağdat Caddesi", "secondary", &[(0, 2000), (4000, 2000)]),
                ("Moda Caddesi", "tertiary", &[(10, 10), (300, 300)]),
            ],
        );
        // Aynı cadde komşu karoda da var: tek sonuçta birleşir.
        let t2 = crate::mvt::tests::tile(
            "transportation_name",
            &[("Bağdat Caddesi", "secondary", &[(0, 2000), (4000, 2000)])],
        );
        index_tile(
            "https://tiles.openfreemap.org/planet/v/14/9513/6144.pbf",
            &t,
        );
        index_tile(
            "https://tiles.openfreemap.org/planet/v/14/9514/6144.pbf",
            &t2,
        );
        // Düşük düzey ve raster karolar dizine girmez.
        index_tile("https://tiles.openfreemap.org/planet/v/10/1/1.pbf", &t);
        let r = search("bagdat cad", Some((29.05, 40.98)), 8);
        assert_eq!(r.len(), 1, "{r:?}");
        assert_eq!(r[0].name, "Bağdat Caddesi");
        assert!(r[0].bbox.is_some());
        assert_eq!(search("moda", None, 8)[0].name, "Moda Caddesi");
        assert_eq!(stats(), (3, 2));
        // Diskten yeniden okunur.
        STREETS.get().unwrap().index.lock().unwrap().loaded = false;
        *STREETS.get().unwrap().index.lock().unwrap() = Index::default();
        assert_eq!(stats(), (3, 2));
        let _ = std::fs::remove_dir_all(&root);
    }
}
