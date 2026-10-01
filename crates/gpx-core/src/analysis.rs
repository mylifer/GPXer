//! Kayıt çözümlemeleri: GPS sıçramalarını temizleme, duraklamaları bulma ve
//! etkinlik türünü tahmin etme.

use crate::parse::{Gpx, Point};
use crate::stats::{haversine_m, Stats, StatsConfig};
use serde::{Deserialize, Serialize};

/// Sıçrama: iz bu kadar uzağa çıkıp geri dönmeli ...
const SPIKE_MIN_DEV_M: f64 = 150.0;
/// ... ve gittiği uzaklık, çıktığı ve döndüğü noktalar arasındaki mesafenin
/// en az bu katı olmalı (düz giden hızlı hareket böylece sıçrama sayılmaz).
const SPIKE_DEV_RATIO: f64 = 2.0;
/// Bir sıçrama en fazla bu kadar nokta ve süre sürebilir.
const SPIKE_MAX_POINTS: usize = 12;
const SPIKE_MAX_MS: i64 = 10 * 60 * 1000;
/// Sıçramadaki hız, çevresindeki olağan hızın en az bu katı ve şu kadar olmalı.
const SPIKE_SPEED_FACTOR: f64 = 3.0;
const SPIKE_MIN_SPEED_MS: f64 = 4.0;
/// Segmentin başında/sonunda izin geri kalanından kopuk en fazla bu kadar nokta atılır.
const EDGE_POINTS: usize = 5;
/// Kopukluk: en az bu kadar uzak ve izin devamındaki hızın bu katından hızlı.
const EDGE_MIN_JUMP_M: f64 = 500.0;
const EDGE_SPEED_FACTOR: f64 = 5.0;
const EDGE_MIN_SPEED_MS: f64 = 30.0;
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

/// İki nokta arasındaki hız (m/s); zaman yoksa `None`. Sıra önemli değildir.
/// Saniyenin altındaki aralıklar 1 sn sayılır (yuvarlanmış zaman damgaları).
fn step_speed(a: &Point, b: &Point) -> Option<f64> {
    let dt = (b.time? - a.time?).abs();
    Some(haversine_m(a, b) / (dt.max(1000) as f64 / 1000.0))
}

/// Verilen noktalar arasındaki adımların ortanca hızı.
fn median_speed<'a>(pts: impl Iterator<Item = &'a Point>) -> Option<f64> {
    let pts: Vec<&Point> = pts.collect();
    median(
        pts.windows(2)
            .filter_map(|w| step_speed(w[0], w[1]))
            .collect(),
    )
}

/// `a`dan çıkıp `run` noktalarından geçerek `b`ye dönen bölüm bir sıçrama mı?
fn is_excursion(a: &Point, run: &[Point], b: &Point, local_speed: Option<f64>) -> bool {
    let d_ab = haversine_m(a, b);
    // Her noktanın iki uca da uzaklığı; sıçramadaki her nokta uzakta olmalı,
    // yoksa sıçramanın öncesindeki/sonrasındaki doğru noktalar da atılırdı.
    let far: Vec<f64> = run
        .iter()
        .map(|p| haversine_m(a, p).min(haversine_m(p, b)))
        .collect();
    let dev = far.iter().copied().fold(0.0, f64::max);
    let near = far.iter().copied().fold(f64::INFINITY, f64::min);
    if dev < SPIKE_MIN_DEV_M
        || dev < SPIKE_DEV_RATIO * d_ab
        || near < (dev * 0.3).max(SPIKE_DEV_RATIO * d_ab)
    {
        return false;
    }
    match (a.time, b.time) {
        (Some(ta), Some(tb)) if tb >= ta => {
            let mut path = 0.0;
            let mut prev = a;
            for p in run.iter().chain(std::iter::once(b)) {
                path += haversine_m(prev, p);
                prev = p;
            }
            let speed = path / ((tb - ta).max(1000) as f64 / 1000.0);
            let usual = local_speed.unwrap_or(0.0);
            speed > (usual * SPIKE_SPEED_FACTOR).max(SPIKE_MIN_SPEED_MS)
        }
        // Zaman yoksa yalnızca belirgin ve kısa dikenler.
        _ => run.len() <= 3 && dev > 300.0 && dev > 3.0 * d_ab,
    }
}

/// `a`dan `b`ye adım, izin devamına göre kopuk mu?
fn is_detached(a: &Point, b: &Point, rest: &[Point]) -> bool {
    let d = haversine_m(a, b);
    if d < EDGE_MIN_JUMP_M {
        return false;
    }
    let usual = median_speed(rest.iter().take(11)).unwrap_or(0.0);
    match step_speed(a, b) {
        Some(v) => v > (usual * EDGE_SPEED_FACTOR).max(EDGE_MIN_SPEED_MS),
        None => {
            let steps: Vec<f64> = rest
                .windows(2)
                .take(10)
                .map(|w| haversine_m(&w[0], &w[1]))
                .collect();
            d > 2000.0 && median(steps).is_some_and(|m| d > 20.0 * m)
        }
    }
}

/// Tek bir segmentteki sıçramaları ayıklar; atılan nokta sayısını döndürür.
///
/// - İzden bir ya da birkaç noktalığına uzağa çıkıp aynı yere dönen,
///   bunu çevresindeki olağan hızın çok üstünde yapan noktalar atılır. Düz
///   giden hızlı hareket (uçak, tren) ve gerçek yer değiştirmeler korunur.
/// - Segmentin başında ya da sonunda izin geri kalanından kopuk birkaç nokta
///   (uydu kilitlenmeden alınmış ya da eski konum) atılır.
pub fn clean_segment(seg: &mut Vec<Point>) -> usize {
    let before = seg.len();
    remove_excursions(seg);
    trim_detached_edges(seg);
    before - seg.len()
}

/// İzden çıkıp aynı yere dönen sıçramaları atar.
fn remove_excursions(seg: &mut Vec<Point>) {
    if seg.len() < 3 {
        return;
    }
    let pts = std::mem::take(seg);
    let mut out: Vec<Point> = Vec::with_capacity(pts.len());
    let mut i = 0;
    while i < pts.len() {
        let Some(a) = out.last().copied() else {
            out.push(pts[i]);
            i += 1;
            continue;
        };
        // Çevredeki olağan hız: önceki 10 nokta ve olası sıçramanın ötesindeki 10 nokta.
        let after = (i + SPIKE_MAX_POINTS).min(pts.len());
        let local = median_speed(
            out[out.len().saturating_sub(10)..]
                .iter()
                .chain(pts[after..].iter().take(10)),
        );
        // Bu noktadan başlayan en kısa sıçrama.
        let spike = (1..=SPIKE_MAX_POINTS)
            .take_while(|&k| i + k < pts.len())
            .take_while(|&k| match (a.time, pts[i + k].time) {
                (Some(ta), Some(tb)) => tb - ta <= SPIKE_MAX_MS,
                _ => true,
            })
            .find(|&k| is_excursion(&a, &pts[i..i + k], &pts[i + k], local));
        match spike {
            Some(k) => i += k,
            None => {
                out.push(pts[i]);
                i += 1;
            }
        }
    }
    *seg = out;
}

/// Segmentin başında ve sonunda izin geri kalanından kopuk birkaç noktayı atar.
fn trim_detached_edges(seg: &mut Vec<Point>) {
    let n = seg.len();
    if n < 3 {
        return;
    }
    // Baştaki k nokta: k. noktaya kopuk bir sıçramayla geçiliyor ve ilk nokta
    // da izin devamından uzakta (geri dönen sıçrama başka kural).
    // En kısa kopuk baş seçilir; böylece kopukluktan sonraki doğru noktalar kalır.
    let head = (1..=EDGE_POINTS.min(n - 2))
        .find(|&k| {
            is_detached(&seg[k - 1], &seg[k], &seg[k..])
                && haversine_m(&seg[0], &seg[k]) > EDGE_MIN_JUMP_M
        })
        .unwrap_or(0);
    let tail = (1..=EDGE_POINTS.min(n.saturating_sub(head + 2)))
        .find(|&k| {
            let i = n - k;
            let rest: Vec<Point> = seg[head..i].iter().rev().copied().collect();
            is_detached(&seg[i], &seg[i - 1], &rest)
                && haversine_m(&seg[n - 1], &seg[i - 1]) > EDGE_MIN_JUMP_M
        })
        .unwrap_or(0);
    seg.truncate(n - tail);
    seg.drain(..head);
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

/// Duraklama sayılması için en az bu kadar süre ...
const STAY_MIN_MS: i64 = 10 * 60 * 1000;
/// ... bu yarıçap içinde kalınmalı.
const STAY_RADIUS_M: f64 = 120.0;
/// Duraklama sırasında yarıçapın dışına en fazla bu kadar nokta/süre çıkılıp
/// dönülebilir (titreme ya da kısa sıçrama); daha uzunsa duraklama biter.
const STAY_MAX_OUT_POINTS: usize = 8;
const STAY_MAX_OUT_MS: i64 = 5 * 60 * 1000;

/// Uzun duraklamaları tek noktaya indirir: bir yerde uzun süre kalınırken GPS
/// konumu onlarca, yüzlerce metre titrer ve iz yumak gibi görünür. Bu
/// aralıktaki noktalar duraklamanın merkezinde, başlangıç ve bitiş zamanlı iki
/// noktaya dönüşür. Atılan nokta sayısını döndürür.
pub fn collapse_stays(gpx: &mut Gpx) -> usize {
    let source = if gpx.tracks.is_empty() {
        &mut gpx.routes
    } else {
        &mut gpx.tracks
    };
    source
        .iter_mut()
        .flat_map(|t| t.segments.iter_mut())
        .map(collapse_segment_stays)
        .sum()
}

/// Tek segmentteki uzun duraklamaları tek noktaya indirir.
pub fn collapse_segment_stays(seg: &mut Vec<Point>) -> usize {
    let n = seg.len();
    if n < 3 || seg.iter().all(|p| p.time.is_none()) {
        return 0;
    }
    let pts = std::mem::take(seg);
    let mut out: Vec<Point> = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        let Some(t0) = pts[i].time else {
            out.push(pts[i]);
            i += 1;
            continue;
        };
        // Yarıçap içindeki noktaların ortalaması merkezdir; dışarı çıkıp kısa
        // sürede dönen noktalar duraklamaya dahildir ama merkezi etkilemez.
        let (mut sum_lat, mut sum_lon, mut count) = (pts[i].lat, pts[i].lon, 1.0);
        let mut last_in = i;
        let mut j = i + 1;
        while j < n {
            let center = Point {
                lat: sum_lat / count,
                lon: sum_lon / count,
                ..Point::default()
            };
            if haversine_m(&center, &pts[j]) <= STAY_RADIUS_M {
                sum_lat += pts[j].lat;
                sum_lon += pts[j].lon;
                count += 1.0;
                last_in = j;
            } else {
                let out_ms = match (pts[last_in].time, pts[j].time) {
                    (Some(a), Some(b)) => b - a,
                    _ => 0,
                };
                if j - last_in > STAY_MAX_OUT_POINTS || out_ms > STAY_MAX_OUT_MS {
                    break;
                }
            }
            j += 1;
        }
        let t1 = pts[last_in].time.unwrap_or(t0);
        if last_in > i + 1 && t1 - t0 >= STAY_MIN_MS {
            let (lat, lon) = (sum_lat / count, sum_lon / count);
            out.push(Point { lat, lon, ..pts[i] });
            out.push(Point {
                lat,
                lon,
                ..pts[last_in]
            });
            i = last_in + 1;
        } else {
            out.push(pts[i]);
            i += 1;
        }
    }
    let removed = n - out.len();
    *seg = out;
    removed
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
