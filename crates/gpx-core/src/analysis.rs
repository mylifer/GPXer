//! Kayıt çözümlemeleri: GPS sıçramalarını temizleme, duraklamaları bulma ve
//! etkinlik türünü tahmin etme.

use crate::parse::{Gpx, Point};
use crate::stats::{haversine_m, Stats, StatsConfig};
use serde::{Deserialize, Serialize};

/// Sıçrama sayılması için iki komşu adımın en az bu kadar uzun olması gerekir.
const SPIKE_MIN_STEP_M: f64 = 30.0;
/// Hız sınırının üst ucu: bunun üstündeki adım her durumda sıçramadır.
const TELEPORT_SPEED_MS: f64 = 120.0;
/// Duraklama: en az bu kadar süre ...
pub const STOP_MIN_MS: i64 = 2 * 60 * 1000;
/// ... bu yarıçap içinde kalınması.
pub const STOP_RADIUS_M: f64 = 40.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Walk,
    Run,
    Bike,
    Car,
    #[default]
    Unknown,
}

impl Activity {
    pub fn parse(s: &str) -> Option<Activity> {
        Some(match s {
            "walk" => Activity::Walk,
            "run" => Activity::Run,
            "bike" => Activity::Bike,
            "car" => Activity::Car,
            "unknown" => Activity::Unknown,
            _ => return None,
        })
    }

    /// Türün kendi hesaplama eşikleri (Ayarlar → "türe göre eşikler").
    pub fn thresholds(self, base: &StatsConfig) -> StatsConfig {
        let (kmh, ele) = match self {
            Activity::Walk => (1.0, 5.0),
            Activity::Run => (2.5, 3.0),
            Activity::Bike => (3.5, 3.0),
            Activity::Car => (6.0, 5.0),
            Activity::Unknown => return *base,
        };
        StatsConfig {
            moving_speed_ms: kmh / 3.6,
            elevation_threshold_m: ele,
            ..*base
        }
    }
}

/// Hız (ve varsa kadans) ile etkinlik türü tahmini.
pub fn classify(s: &Stats) -> Activity {
    let Some(avg) = s.avg_moving_speed_ms.map(|v| v * 3.6) else {
        return Activity::Unknown;
    };
    let max = s.max_speed_ms.map_or(0.0, |v| v * 3.6);
    // Koşuda adım kadansı ~150–190; bisiklette pedal kadansı ~60–100.
    let running_cadence = s.avg_cad.is_some_and(|c| c > 130.0);
    if avg >= 40.0 || max >= 90.0 {
        Activity::Car
    } else if avg < 7.0 {
        Activity::Walk
    } else if running_cadence || (avg < 13.0 && max < 28.0) || (avg < 16.0 && max < 25.0) {
        Activity::Run
    } else {
        Activity::Bike
    }
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

/// Hız sınırı en az bu (43 km/sa): yürüyüş/koşu kayıtlarında bunun üstü sıçramadır.
const SPEED_FLOOR_MS: f64 = 12.0;
/// Sıçramadan sonra izin geri döndüğü nokta en fazla bu kadar ileride aranır.
const LOOKAHEAD_POINTS: usize = 40;
const LOOKAHEAD_MS: i64 = 3 * 60 * 1000;
/// Segmentin başında/sonunda bu kadar ya da daha az nokta, izin geri kalanından
/// akla yatkın olmayan hızla kopuksa (uydu kilitlenmeden alınmış konumlar) atılır.
const EDGE_POINTS: usize = 5;

/// İki nokta arasındaki hız (m/s); zaman yoksa ya da geri gidiyorsa `None`.
/// Saniyenin altındaki aralıklar 1 sn sayılır (yuvarlanmış zaman damgaları).
fn step_speed(a: &Point, b: &Point) -> Option<f64> {
    let dt = b.time? - a.time?;
    (dt >= 0).then(|| haversine_m(a, b) / (dt.max(1000) as f64 / 1000.0))
}

/// Tek bir segmentteki sıçramaları ayıklar; atılan nokta sayısını döndürür.
///
/// - Kaydın olağan hızına göre akla yatkın olmayan hızla başka yere gidip
///   (bir ya da birkaç nokta) yeniden ize dönen konumlar atılır.
/// - Segmentin başında ya da sonunda izden kopuk birkaç nokta atılır.
/// - Zaman bilgisi olmayan izlerde gidip geri gelen tek nokta (sivri diken)
///   atılır.
pub fn clean_segment(seg: &mut Vec<Point>) -> usize {
    if seg.len() < 3 {
        return 0;
    }
    // Hareket hâlindeki adımların ortanca hızının 4 katı; 43–432 km/sa arası.
    let moving: Vec<f64> = seg
        .windows(2)
        .filter_map(|w| step_speed(&w[0], &w[1]))
        .filter(|&v| v > 0.5)
        .collect();
    let limit = median(moving).map_or(SPEED_FLOOR_MS, |m| {
        (m * 4.0).clamp(SPEED_FLOOR_MS, TELEPORT_SPEED_MS)
    });
    let too_fast = |a: &Point, b: &Point| {
        haversine_m(a, b) > SPIKE_MIN_STEP_M && step_speed(a, b).is_some_and(|v| v > limit)
    };

    let n = seg.len();
    let mut out: Vec<Point> = Vec::with_capacity(n);
    let mut removed = 0;
    let mut i = 0;
    while i < n {
        let p = seg[i];
        let Some(last) = out.last().copied() else {
            out.push(p);
            i += 1;
            continue;
        };
        if too_fast(&last, &p) {
            // İz, son güvenilir noktadan olağan hızla varılabilecek bir yere
            // dönüyor mu? Dönüyorsa aradakiler sıçramadır.
            let back = (i + 1..n.min(i + 1 + LOOKAHEAD_POINTS))
                .take_while(|&j| match (last.time, seg[j].time) {
                    (Some(a), Some(b)) => b - a <= LOOKAHEAD_MS,
                    _ => true,
                })
                .find(|&j| !too_fast(&last, &seg[j]));
            if let Some(j) = back {
                removed += j - i;
                i = j;
                continue;
            }
            if out.len() <= EDGE_POINTS && n - i > EDGE_POINTS {
                // Baştaki kopuk noktalar.
                removed += out.len();
                out.clear();
            } else if n - i <= EDGE_POINTS {
                // Sondaki kopuk noktalar.
                removed += n - i;
                break;
            }
            // Aksi hâlde gerçek bir yer değiştirme (ör. sinyal kaybından sonra).
            out.push(p);
            i += 1;
            continue;
        }
        // Zamansız izlerde sivri diken: önceki ve sonraki noktaya uzak, ama
        // onlar birbirine yakın.
        if p.time.is_none() || last.time.is_none() {
            if let Some(next) = seg.get(i + 1) {
                let d_in = haversine_m(&last, &p);
                let d_out = haversine_m(&p, next);
                if d_in > 200.0
                    && d_out > 200.0
                    && haversine_m(&last, next) < 0.35 * d_in.min(d_out)
                {
                    removed += 1;
                    i += 1;
                    continue;
                }
            }
        }
        out.push(p);
        i += 1;
    }
    *seg = out;
    removed
}

/// Kaydın asıl segmentlerindeki sıçramaları temizler.
pub fn clean_spikes(gpx: &mut Gpx) -> usize {
    let source = if gpx.tracks.is_empty() {
        &mut gpx.routes
    } else {
        &mut gpx.tracks
    };
    source
        .iter_mut()
        .flat_map(|t| t.segments.iter_mut())
        .map(clean_segment)
        .sum()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub lat: f64,
    pub lon: f64,
    /// Duraklamanın başladığı an (Unix ms).
    pub start: i64,
    pub duration_ms: i64,
}

/// Zaman bilgili segmentlerde en az [`STOP_MIN_MS`] boyunca [`STOP_RADIUS_M`]
/// yarıçapında kalınan yerleri bulur. Cihazın kapalı kaldığı (iki nokta arası
/// uzun boşluk) ama yer değiştirmediği anlar da duraklama sayılır.
pub fn detect_stops<'a>(segments: impl IntoIterator<Item = &'a [Point]>) -> Vec<Stop> {
    let mut stops = Vec::new();
    for seg in segments {
        let mut i = 0;
        while i < seg.len() {
            let Some(t0) = seg[i].time else {
                i += 1;
                continue;
            };
            let anchor = seg[i];
            let mut j = i;
            while j + 1 < seg.len() && haversine_m(&anchor, &seg[j + 1]) <= STOP_RADIUS_M {
                j += 1;
            }
            let t1 = seg[j].time.unwrap_or(t0);
            if j > i && t1 - t0 >= STOP_MIN_MS {
                let n = (j - i + 1) as f64;
                let (lat, lon) = seg[i..=j]
                    .iter()
                    .fold((0.0, 0.0), |(a, b), p| (a + p.lat, b + p.lon));
                stops.push(Stop {
                    lat: lat / n,
                    lon: lon / n,
                    start: t0,
                    duration_ms: t1 - t0,
                });
                i = j + 1;
            } else {
                i += 1;
            }
        }
    }
    stops
}
