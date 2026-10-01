//! Kayıt çözümlemeleri: GPS sıçramalarını temizleme, duraklamaları bulma ve
//! etkinlik türünü tahmin etme.

use crate::parse::{Gpx, Point};
use crate::stats::{haversine_m, Stats, StatsConfig};
use serde::{Deserialize, Serialize};

/// Sıçrama sayılması için iki komşu adımın en az bu kadar uzun olması gerekir.
const SPIKE_MIN_STEP_M: f64 = 30.0;
/// Bu hızın üstündeki tek adım (ör. yanlış uydu kilidi) her durumda sıçramadır.
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

/// Tek bir segmentteki sıçramaları ayıklar; atılan nokta sayısını döndürür.
///
/// İki tür sıçrama yakalanır:
/// - gidip geri gelen nokta: önceki ve sonraki noktaya uzak, ama onlar
///   birbirine yakın (izde sivri bir diken);
/// - akla yatkın olmayan hızla tek adımda başka yere atlama.
pub fn clean_segment(seg: &mut Vec<Point>) -> usize {
    if seg.len() < 3 {
        return 0;
    }
    let speeds: Vec<f64> = seg
        .windows(2)
        .filter_map(|w| {
            let dt = (w[1].time? - w[0].time?) as f64 / 1000.0;
            (dt > 0.0).then(|| haversine_m(&w[0], &w[1]) / dt)
        })
        .collect();
    // Kaydın olağan hızının birkaç katı, ama en az 15 m/s (54 km/sa).
    let fast = median(speeds).map_or(15.0, |m| (m * 4.0).max(15.0));

    let mut out: Vec<Point> = Vec::with_capacity(seg.len());
    let mut removed = 0;
    for i in 0..seg.len() {
        let p = seg[i];
        let Some(prev) = out.last().copied() else {
            out.push(p);
            continue;
        };
        let d_in = haversine_m(&prev, &p);
        let speed_in = match (prev.time, p.time) {
            (Some(a), Some(b)) if b > a => Some(d_in / ((b - a) as f64 / 1000.0)),
            _ => None,
        };
        if speed_in.is_some_and(|v| v > TELEPORT_SPEED_MS) {
            removed += 1;
            continue;
        }
        if let Some(next) = seg.get(i + 1) {
            let d_out = haversine_m(&p, next);
            let d_skip = haversine_m(&prev, next);
            let out_and_back = d_in > SPIKE_MIN_STEP_M
                && d_out > SPIKE_MIN_STEP_M
                && d_skip < 0.35 * d_in.min(d_out);
            let speed_out = match (p.time, next.time) {
                (Some(a), Some(b)) if b > a => Some(d_out / ((b - a) as f64 / 1000.0)),
                _ => None,
            };
            let too_fast = match (speed_in, speed_out) {
                (Some(a), Some(b)) => a > fast && b > fast,
                // Zaman yoksa yalnızca belirgin (200 m üstü) dikenler.
                _ => d_in > 200.0 && d_out > 200.0,
            };
            if out_and_back && too_fast {
                removed += 1;
                continue;
            }
        }
        out.push(p);
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
