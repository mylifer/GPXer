//! İmlecin altındaki yer: en yakın adlı yol ve mahalle/ilçe. Harita
//! altlığından bağımsız olarak vektör karolarından (önbellek önce) okunur;
//! çözülmüş karolar bellekte tutulur, fare hareketinde yeniden çözülmez.

use crate::mvt::Locality;
use crate::run_blocking;
use crate::tiles::{vector_template, TileCache};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

/// Sokak bu kadar yakınsa adı verilir (m).
const STREET_M: f64 = 60.0;
/// Mahalle/semt bu kadar yakınsa (m).
const SMALL_M: f64 = 2500.0;
/// İlçe merkezi ya da semt bu kadar yakınsa (m).
const BIG_M: f64 = 9000.0;

#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct StreetAt {
    street: Option<String>,
    /// "Erenköy, Kadıköy"
    area: Option<String>,
}

pub(crate) fn tile_xy(lon: f64, lat: f64, z: u32) -> (u32, u32) {
    let n = 2f64.powi(z as i32);
    let x = ((lon + 180.0) / 360.0 * n).floor().clamp(0.0, n - 1.0) as u32;
    let r = lat.clamp(-85.0, 85.0).to_radians();
    let y = ((1.0 - (r.tan() + 1.0 / r.cos()).ln() / std::f64::consts::PI) / 2.0 * n)
        .floor()
        .clamp(0.0, n - 1.0) as u32;
    (x, y)
}

/// Yerel düzlemde metre (kısa mesafeler için yeterli).
fn local(lon: f64, lat: f64, at: (f64, f64)) -> (f64, f64) {
    let k = 111_320.0;
    ((lon - at.0) * k * at.1.to_radians().cos(), (lat - at.1) * k)
}

/// Noktanın çizgiye uzaklığı (m).
fn dist_to_line(line: &[(f64, f64)], at: (f64, f64)) -> f64 {
    let mut best = f64::INFINITY;
    for w in line.windows(2) {
        let (ax, ay) = local(w[0].0, w[0].1, at);
        let (bx, by) = local(w[1].0, w[1].1, at);
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let t = if len2 > 0.0 {
            (-(ax * dx + ay * dy) / len2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let (px, py) = (ax + t * dx, ay + t * dy);
        best = best.min((px * px + py * py).sqrt());
    }
    if line.len() == 1 {
        let (x, y) = local(line[0].0, line[0].1, at);
        best = (x * x + y * y).sqrt();
    }
    best
}

/// Noktadaki yer: (sokak, mahalle/semt, ilçe ya da büyük semt).
pub(crate) type Located = (Option<String>, Option<String>, Option<String>);

/// Karolardan sokak, mahalle ve ilçe (saf: denenebilir). `area`: mahalle ve
/// ilçe de bulunsun mu (güzergâh dökümünde her noktada gerekmez).
pub(crate) fn locate(fine: &Locality, coarse: &Locality, at: (f64, f64), area: bool) -> Located {
    let street = fine
        .roads
        .iter()
        .flat_map(|(n, lines)| lines.iter().map(move |l| (n, dist_to_line(l, at))))
        .filter(|(_, d)| *d <= STREET_M)
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(n, _)| n.clone());
    if !area {
        return (street, None, None);
    }
    let near = |classes: &[&str], max: f64| {
        fine.places
            .iter()
            .chain(coarse.places.iter())
            .filter(|p| classes.contains(&p.1.as_str()))
            .map(|p| {
                let (x, y) = local(p.2, p.3, at);
                (p.0.clone(), (x * x + y * y).sqrt())
            })
            .filter(|(_, d)| *d <= max)
            .min_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(n, _)| n)
    };
    let small = near(
        &[
            "quarter",
            "neighbourhood",
            "hamlet",
            "village",
            "isolated_dwelling",
        ],
        SMALL_M,
    );
    let big = near(&["suburb", "town"], BIG_M)
        .or_else(|| near(&["city"], BIG_M * 2.0))
        .or_else(|| crate::geo::place_at(at.0, at.1))
        .filter(|b| Some(b) != small.as_ref());
    (street, small, big)
}

/// Karolardan yer bilgisi (saf: denenebilir).
pub(crate) fn describe(fine: &Locality, coarse: &Locality, at: (f64, f64)) -> StreetAt {
    let (street, small, big) = locate(fine, coarse, at, true);
    let parts: Vec<String> = [small, big].into_iter().flatten().collect();
    StreetAt {
        street,
        area: (!parts.is_empty()).then(|| parts.join(", ")),
    }
}

/// Çözülmüş karolar (son kullanılanlar).
struct Memo {
    map: HashMap<(u32, u32, u32), Arc<Locality>>,
    order: VecDeque<(u32, u32, u32)>,
}

pub(crate) fn decoded(cache: &TileCache, z: u32, x: u32, y: u32) -> Result<Arc<Locality>, String> {
    static MEMO: Mutex<Option<Memo>> = Mutex::new(None);
    if let Some(hit) = MEMO
        .lock()
        .ok()
        .and_then(|m| m.as_ref().and_then(|m| m.map.get(&(z, x, y)).cloned()))
    {
        return Ok(hit);
    }
    let url = vector_template(cache)?
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string());
    let loc = Arc::new(crate::mvt::locality(&cache.get(&url)?, z, x, y));
    if let Ok(mut g) = MEMO.lock() {
        let m = g.get_or_insert_with(|| Memo {
            map: HashMap::new(),
            order: VecDeque::new(),
        });
        if m.map.insert((z, x, y), loc.clone()).is_none() {
            m.order.push_back((z, x, y));
        }
        while m.order.len() > 96 {
            if let Some(k) = m.order.pop_front() {
                m.map.remove(&k);
            }
        }
    }
    Ok(loc)
}

/// İmlecin altındaki sokak ve mahalle/ilçe (internet yoksa önbellekteki
/// karolardan; o da yoksa yalnızca yerleşim listesinden ilçe).
#[tauri::command]
pub(crate) async fn street_at(app: AppHandle, lon: f64, lat: f64) -> Result<StreetAt, String> {
    run_blocking(move || {
        let cache = app.state::<TileCache>();
        let (fx, fy) = tile_xy(lon, lat, 14);
        let (cx, cy) = tile_xy(lon, lat, 12);
        let fine = decoded(&cache, 14, fx, fy).unwrap_or_default();
        let coarse = decoded(&cache, 12, cx, cy).unwrap_or_default();
        Ok(describe(&fine, &coarse, (lon, lat)))
    })
    .await?
}

/// Durak bu kadar yakınsa mekânın adı verilir (m).
const VENUE_M: f64 = 60.0;
/// Durak yeri olarak anlamsız POI sınıfları.
const VENUE_SKIP: &[&str] = &[
    "bus",
    "bus_stop",
    "parking",
    "bicycle_parking",
    "motorcycle_parking",
    "toilets",
    "atm",
    "post_box",
    "bench",
    "drinking_water",
    "waste_basket",
    "vending_machine",
];

#[derive(Serialize, Debug, PartialEq, Clone)]
pub(crate) struct Venue {
    pub name: String,
    /// OpenMapTiles POI sınıfı ("cafe", "restaurant", "museum"…).
    pub kind: String,
}

/// En yakın adlı mekân (saf: denenebilir).
pub(crate) fn nearest_venue(names: &[crate::mvt::Named], at: (f64, f64)) -> Option<Venue> {
    names
        .iter()
        .filter_map(|n| {
            let kind = n.kind.strip_prefix("poi:")?;
            if VENUE_SKIP.contains(&kind) {
                return None;
            }
            let (x, y) = local(n.lon, n.lat, at);
            let d = (x * x + y * y).sqrt();
            (d <= VENUE_M).then_some((d, n, kind))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, n, kind)| Venue {
            name: n.name.clone(),
            kind: kind.to_owned(),
        })
}

type NamesMemo = (
    HashMap<(u32, u32), Arc<Vec<crate::mvt::Named>>>,
    VecDeque<(u32, u32)>,
);

/// Karodaki adlı öğeler (son kullanılanlar bellekte).
fn tile_names(cache: &TileCache, x: u32, y: u32) -> Arc<Vec<crate::mvt::Named>> {
    static MEMO: Mutex<Option<NamesMemo>> = Mutex::new(None);
    if let Some(hit) = MEMO
        .lock()
        .ok()
        .and_then(|m| m.as_ref().and_then(|m| m.0.get(&(x, y)).cloned()))
    {
        return hit;
    }
    let names = vector_template(cache)
        .and_then(|t| {
            let url = t
                .replace("{z}", "14")
                .replace("{x}", &x.to_string())
                .replace("{y}", &y.to_string());
            cache.get(&url)
        })
        .map(|b| crate::mvt::names(&b, 14, x, y))
        .unwrap_or_default();
    let names = Arc::new(names);
    if let Ok(mut g) = MEMO.lock() {
        let (map, order) = g.get_or_insert_with(Default::default);
        if map.insert((x, y), names.clone()).is_none() {
            order.push_back((x, y));
        }
        while order.len() > 64 {
            if let Some(k) = order.pop_front() {
                map.remove(&k);
            }
        }
    }
    names
}

/// Duraklardaki mekânlar (kafe, lokanta, müze…): her nokta için en yakın
/// adlı OpenStreetMap mekânı ya da `None`. Karolar önbellekten, yoksa
/// internetten.
#[tauri::command]
pub(crate) async fn venues_at(
    app: AppHandle,
    points: Vec<[f64; 2]>,
) -> Result<Vec<Option<Venue>>, String> {
    run_blocking(move || {
        let cache = app.state::<TileCache>();
        Ok(points
            .into_iter()
            .map(|[lon, lat]| {
                let (x, y) = tile_xy(lon, lat, 14);
                nearest_venue(&tile_names(&cache, x, y), (lon, lat))
            })
            .collect())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_named_venue_near_stop() {
        use crate::mvt::Named;
        let n = |name: &str, kind: &str, lon: f64, lat: f64| Named {
            name: name.into(),
            kind: kind.into(),
            lon,
            lat,
        };
        let at = (29.0250, 40.9800);
        let names = vec![
            n("Moda Çay Bahçesi", "poi:cafe", 29.0252, 40.9801),
            n("Otopark", "poi:parking", 29.02501, 40.98001),
            n("Uzak Müze", "poi:museum", 29.0300, 40.9800),
            n("Moda Caddesi", "street", 29.0250, 40.9800),
        ];
        assert_eq!(
            nearest_venue(&names, at),
            Some(Venue {
                name: "Moda Çay Bahçesi".into(),
                kind: "cafe".into()
            })
        );
        assert_eq!(nearest_venue(&names, (29.05, 40.99)), None);
    }

    #[test]
    fn picks_nearest_street_and_area() {
        let at = (29.0800, 40.9720);
        let fine = Locality {
            roads: vec![
                // ~10 m kuzeyde.
                (
                    "Fırın Sokak".into(),
                    vec![vec![(29.0790, 40.97209), (29.0810, 40.97209)]],
                ),
                // ~200 m uzakta.
                (
                    "Bağdat Caddesi".into(),
                    vec![vec![(29.0790, 40.9738), (29.0810, 40.9738)]],
                ),
            ],
            places: vec![("Erenköy".into(), "quarter".into(), 29.078, 40.973)],
        };
        let coarse = Locality {
            roads: vec![],
            places: vec![
                ("Kadıköy".into(), "suburb".into(), 29.03, 40.99),
                ("İstanbul".into(), "city".into(), 28.97, 41.01),
            ],
        };
        let r = describe(&fine, &coarse, at);
        assert_eq!(r.street.as_deref(), Some("Fırın Sokak"));
        assert_eq!(r.area.as_deref(), Some("Erenköy, Kadıköy"));
        // Yol uzaksa sokak adı verilmez.
        let r = describe(&fine, &coarse, (29.10, 40.95));
        assert_eq!(r.street, None);
    }

    #[test]
    fn tile_numbers() {
        assert_eq!(tile_xy(29.03, 40.99, 14), (9513, 6143));
    }
}
