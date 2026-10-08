//! Güzergâh dökümü: kaydın geçtiği yollar sırayla, mesafeleri ve
//! mahalle/ilçeleriyle (vektör karolarından). Kayıt başına diskte saklanır;
//! dosya değişince yeniden hesaplanır. Özet'teki yol ve mahalle
//! istatistikleri de bu dökümlerden çıkar.

use crate::mvt::Locality;
use crate::run_blocking;
use crate::streetat::{decoded, locate, tile_xy};
use crate::tiles::TileCache;
use gpx_core::Detail;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// Örnekler arası mesafe (m).
const STEP_M: f64 = 100.0;
/// Bundan kısa ve iki yanı aynı yol olan bölüm (kavşak, yan yol) komşusuna katılır (m).
const BLIP_M: f64 = 250.0;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Seg {
    /// Yol adı; adsız yolda yok.
    pub name: Option<String>,
    /// Mahalle/semt ve ilçe (bölümün ortasında).
    pub small: Option<String>,
    pub big: Option<String>,
    /// Ayrıntı örneklerinde başlangıç ve bitiş sırası.
    pub from: usize,
    pub to: usize,
    pub dist_m: f64,
}

/// Örnek: (ayrıntı sırası, kümülatif mesafe, yol adı).
type Sample = (usize, f64, Option<String>);

/// Örnekleri yol bölümlerine çevirir (saf: denenebilir).
pub(crate) fn segments(samples: &[Sample]) -> Vec<Seg> {
    let mut segs: Vec<Seg> = Vec::new();
    for w in samples.windows(2) {
        let (i, d, name) = &w[0];
        let (j, d2, _) = &w[1];
        match segs.last_mut() {
            Some(s) if s.name == *name => {
                s.to = *j;
                s.dist_m += d2 - d;
            }
            _ => segs.push(Seg {
                name: name.clone(),
                small: None,
                big: None,
                from: *i,
                to: *j,
                dist_m: d2 - d,
            }),
        }
    }
    // Kısa sapmalar: iki yanı aynı yolsa ya da adsızsa komşuya katılır.
    let mut i = 1;
    while i + 1 < segs.len() {
        let short = segs[i].dist_m < BLIP_M;
        if short && (segs[i - 1].name == segs[i + 1].name || segs[i].name.is_none()) {
            let mid = segs.remove(i);
            let prev = &mut segs[i - 1];
            prev.to = mid.to;
            prev.dist_m += mid.dist_m;
            if segs[i - 1].name == segs[i].name {
                let next = segs.remove(i);
                segs[i - 1].to = next.to;
                segs[i - 1].dist_m += next.dist_m;
            }
        } else {
            i += 1;
        }
    }
    // Baştaki/sondaki kısa adsız parça.
    if segs.len() > 1 && segs[0].name.is_none() && segs[0].dist_m < BLIP_M {
        let first = segs.remove(0);
        segs[0].from = first.from;
        segs[0].dist_m += first.dist_m;
    }
    if segs.len() > 1 && segs[segs.len() - 1].name.is_none() && segs[segs.len() - 1].dist_m < BLIP_M
    {
        let last = segs.pop().unwrap_or_else(|| unreachable!());
        let l = segs.len() - 1;
        segs[l].to = last.to;
        segs[l].dist_m += last.dist_m;
    }
    segs
}

/// Ayrıntıdan güzergâh dökümü; `tile` karoyu verir (önbellek/indirme).
pub(crate) fn itinerary(
    d: &Detail,
    mut tile: impl FnMut(u32, u32, u32) -> Arc<Locality>,
) -> Vec<Seg> {
    let n = d.dist.len();
    if n < 2 {
        return Vec::new();
    }
    let gap: std::collections::HashSet<usize> = d.gap_after.iter().map(|&g| g as usize).collect();
    let at = |i: usize| (d.lon[i], d.lat[i]);
    let fine = |tile: &mut dyn FnMut(u32, u32, u32) -> Arc<Locality>, (lon, lat): (f64, f64)| {
        let (x, y) = tile_xy(lon, lat, 14);
        tile(14, x, y)
    };
    let mut samples: Vec<Sample> = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for i in 0..n {
        // Boşluğun (uçuş, sinyal kaybı) iki ucu da örneklenir.
        if d.dist[i] - last >= STEP_M
            || i == n - 1
            || gap.contains(&i)
            || (i > 0 && gap.contains(&(i - 1)))
        {
            let f = fine(&mut tile, at(i));
            let empty = Locality::default();
            samples.push((i, d.dist[i], locate(&f, &empty, at(i), false).0));
            last = d.dist[i];
        }
    }
    let mut segs = segments(&samples);
    // Mahalle ve ilçe: bölümün ortasındaki örnekte.
    for s in &mut segs {
        let mid = samples
            .iter()
            .filter(|x| x.0 >= s.from && x.0 <= s.to)
            .min_by(|a, b| {
                (a.1 - (d.dist[s.from] + d.dist[s.to]) / 2.0)
                    .abs()
                    .total_cmp(&(b.1 - (d.dist[s.from] + d.dist[s.to]) / 2.0).abs())
            })
            .map_or(s.from, |x| x.0);
        let f = fine(&mut tile, at(mid));
        let (cx, cy) = tile_xy(at(mid).0, at(mid).1, 12);
        let c = tile(12, cx, cy);
        let (_, small, big) = locate(&f, &c, at(mid), true);
        s.small = small;
        s.big = big;
    }
    segs
}

#[derive(Serialize, Deserialize)]
struct Cached {
    /// Dosya boyutu ve değişme zamanı: değişince yeniden hesaplanır.
    sig: (u64, u64),
    segs: Vec<Seg>,
}

struct Store {
    path: PathBuf,
    map: Mutex<Option<HashMap<String, Cached>>>,
}

static STORE: OnceLock<Store> = OnceLock::new();

pub(crate) fn init(root: &std::path::Path) {
    let _ = STORE.set(Store {
        path: root.join("guzergahlar.json"),
        map: Mutex::new(None),
    });
}

fn sig(path: &str) -> (u64, u64) {
    std::fs::metadata(path)
        .map(|m| {
            let t = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            (m.len(), t)
        })
        .unwrap_or_default()
}

fn with_map<R>(f: impl FnOnce(&mut HashMap<String, Cached>) -> R) -> Option<R> {
    let s = STORE.get()?;
    let mut g = s.map.lock().unwrap_or_else(|e| e.into_inner());
    let m = g.get_or_insert_with(|| {
        std::fs::read(&s.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    });
    Some(f(m))
}

fn save() {
    let Some(s) = STORE.get() else { return };
    let bytes = {
        let g = s.map.lock().unwrap_or_else(|e| e.into_inner());
        g.as_ref().and_then(|m| serde_json::to_vec(m).ok())
    };
    if let Some(b) = bytes {
        let _ = crate::store::write_atomic(&s.path, &b);
    }
}

fn cached(path: &str) -> Option<Vec<Seg>> {
    let sg = sig(path);
    with_map(|m| m.get(path).filter(|c| c.sig == sg).map(|c| c.segs.clone())).flatten()
}

/// Kaydın dökümü: önbellekte yoksa hesaplanır (karolar gerekirse indirilir).
fn compute(app: &AppHandle, path: &str) -> Result<Vec<Seg>, String> {
    if let Some(c) = cached(path) {
        return Ok(c);
    }
    let cfg = app.state::<crate::settings::SettingsStore>().stats();
    let p = crate::prepared(app, path, &cfg)?;
    let d = gpx_core::build_detail(&p.gpx);
    let cache = app.state::<TileCache>();
    let mut local: HashMap<(u32, u32, u32), Arc<Locality>> = HashMap::new();
    let segs = itinerary(&d, |z, x, y| {
        local
            .entry((z, x, y))
            .or_insert_with(|| decoded(&cache, z, x, y).unwrap_or_default())
            .clone()
    });
    // Hiç karo okunamadıysa (internet yok, önbellekte yok) saklanmaz.
    if segs.iter().any(|s| s.name.is_some() || s.big.is_some()) {
        with_map(|m| {
            m.insert(
                path.to_owned(),
                Cached {
                    sig: sig(path),
                    segs: segs.clone(),
                },
            )
        });
    }
    Ok(segs)
}

#[tauri::command]
pub(crate) async fn record_roads(app: AppHandle, path: String) -> Result<Vec<Seg>, String> {
    run_blocking(move || {
        let r = compute(&app, &path);
        save();
        r
    })
    .await?
}

/// Birden çok kaydın dökümünü hazırlar (Özet istatistikleri için); hazır
/// (önbellekte) olanlar atlanır. Dönüş: hazır olan kayıt sayısı.
#[tauri::command]
pub(crate) async fn prepare_roads(app: AppHandle, paths: Vec<String>) -> Result<usize, String> {
    run_blocking(move || {
        let ok = paths
            .iter()
            .filter(|p| compute(&app, p).is_ok_and(|s| !s.is_empty()))
            .count();
        save();
        ok
    })
    .await
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoadStats {
    /// Dökümü hazır kayıt sayısı.
    ready: usize,
    /// En çok geçilen yollar: (ad, ilçe, toplam m, kayıt sayısı).
    roads: Vec<(String, Option<String>, f64, usize)>,
    /// İlçe ilçe geçilen mahalleler: (ilçe, [(mahalle, kayıt sayısı)]).
    hoods: Vec<(String, Vec<(String, usize)>)>,
}

/// Önbellekteki dökümlerden yol ve mahalle istatistikleri (hesaplama yapmaz).
#[tauri::command]
pub(crate) async fn road_stats(paths: Vec<String>) -> Result<RoadStats, String> {
    run_blocking(move || {
        let mut roads: HashMap<(String, Option<String>), (f64, usize)> = HashMap::new();
        let mut hoods: HashMap<String, HashMap<String, usize>> = HashMap::new();
        let mut ready = 0;
        for p in &paths {
            let Some(segs) = cached(p) else { continue };
            ready += 1;
            let mut seen_roads = std::collections::HashSet::new();
            let mut seen_hoods = std::collections::HashSet::new();
            for s in &segs {
                if let Some(n) = &s.name {
                    let k = (n.clone(), s.big.clone());
                    let e = roads.entry(k.clone()).or_default();
                    e.0 += s.dist_m;
                    if seen_roads.insert(k) {
                        e.1 += 1;
                    }
                }
                if let (Some(b), Some(sm)) = (&s.big, &s.small) {
                    if seen_hoods.insert((b.clone(), sm.clone())) {
                        *hoods
                            .entry(b.clone())
                            .or_default()
                            .entry(sm.clone())
                            .or_default() += 1;
                    }
                }
            }
        }
        let mut roads: Vec<_> = roads
            .into_iter()
            .map(|((n, b), (d, c))| (n, b, d, c))
            .collect();
        roads.sort_by(|a, b| b.2.total_cmp(&a.2));
        roads.truncate(30);
        let mut hoods: Vec<(String, Vec<(String, usize)>)> = hoods
            .into_iter()
            .map(|(b, m)| {
                let mut v: Vec<_> = m.into_iter().collect();
                v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                (b, v)
            })
            .collect();
        hoods.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then_with(|| a.0.cmp(&b.0)));
        RoadStats {
            ready,
            roads,
            hoods,
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(i: usize, d: f64, n: Option<&str>) -> Sample {
        (i, d, n.map(str::to_owned))
    }

    #[test]
    fn merges_runs_and_absorbs_blips() {
        let samples = vec![
            s(0, 0.0, None),
            s(1, 100.0, Some("Bağdat Caddesi")),
            s(2, 200.0, Some("Bağdat Caddesi")),
            s(3, 300.0, Some("Bağdat Caddesi")),
            // Kavşakta bir örnek başka yol.
            s(4, 400.0, Some("Ara Sokak")),
            s(5, 500.0, Some("Bağdat Caddesi")),
            s(6, 600.0, Some("Bağdat Caddesi")),
            s(7, 1600.0, Some("D-100")),
            s(8, 5600.0, Some("D-100")),
        ];
        let segs = segments(&samples);
        let names: Vec<_> = segs
            .iter()
            .map(|s| (s.name.clone().unwrap_or_default(), s.dist_m.round() as i64))
            .collect();
        assert_eq!(
            names,
            vec![
                ("Bağdat Caddesi".to_owned(), 1600),
                ("D-100".to_owned(), 4000)
            ]
        );
        assert_eq!(segs[0].from, 0);
        assert_eq!(segs[1].to, 8);
    }

    #[test]
    fn itinerary_from_tiles() {
        // Doğu-batı giden kayıt; ilk yarısı bir caddede, ikinci yarısı otoyolda.
        let n = 41;
        let lon: Vec<f64> = (0..n).map(|i| 29.00 + i as f64 * 0.0012).collect();
        let lat = vec![40.98; n];
        let dist: Vec<f64> = (0..n).map(|i| i as f64 * 101.0).collect();
        let d = Detail {
            dist,
            ele: vec![None; n],
            speed: vec![None; n],
            time: vec![None; n],
            lat: lat.clone(),
            lon: lon.clone(),
            idx: (0..n as u32).collect(),
            hr: vec![],
            cad: vec![],
            power: vec![],
            temp: vec![],
            gap_after: vec![],
        };
        let road = |name: &str, a: f64, b: f64| {
            (name.to_owned(), vec![vec![(a, 40.98001), (b, 40.98001)]])
        };
        let loc = Arc::new(Locality {
            roads: vec![
                road("Bağdat Caddesi", 28.99, 29.024),
                road("D-100", 29.024, 29.06),
            ],
            places: vec![
                ("Erenköy".into(), "quarter".into(), 29.01, 40.979),
                ("Kadıköy".into(), "suburb".into(), 29.03, 40.99),
            ],
        });
        let segs = itinerary(&d, |_, _, _| loc.clone());
        let names: Vec<_> = segs
            .iter()
            .map(|s| s.name.clone().unwrap_or_default())
            .collect();
        assert_eq!(names, ["Bağdat Caddesi", "D-100"]);
        assert_eq!(segs[0].small.as_deref(), Some("Erenköy"));
        assert_eq!(segs[0].big.as_deref(), Some("Kadıköy"));
        assert_eq!(segs[1].to, n - 1);
    }
}
