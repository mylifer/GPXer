//! Asıl segmentler, kayıt boşlukları ve saatlik toplamlar.

use crate::parse::{Gpx, Point};
use crate::stats::{self, compute_stats, Stats, StatsConfig};
use crate::Gap;

/// Dosyanın asıl verisi olarak kullanılacak segmentler: iz (track) varsa
/// onlar, yoksa rotalar (route).
pub fn primary_segments(gpx: &Gpx) -> Vec<&[Point]> {
    let source = if gpx.tracks.is_empty() {
        &gpx.routes
    } else {
        &gpx.tracks
    };
    source
        .iter()
        .flat_map(|t| t.segments.iter().map(|s| s.as_slice()))
        .collect()
}

/// Bu kadar süre ve mesafe nokta yoksa boşluk sayılır (sinyal kaybı, kaydın
/// durdurulup başka yerde sürdürülmesi). Daha kısa aralıklar seyrek kayıttır;
/// iz bağlı kalır.
const GAP_MIN_MS: i64 = 10 * 60 * 1000;
const GAP_MIN_M: f64 = 2000.0;
/// Süre kısa olsa da uçuş hızında uzun atlama da boşluktur.
const GAP_FLIGHT_M: f64 = 20_000.0;
const GAP_FLIGHT_SPEED_MS: f64 = 300.0 / 3.6;
/// Zaman bilgisi yoksa yalnızca mesafeye bakılır.
const GAP_MIN_M_UNTIMED: f64 = 10_000.0;

pub(crate) fn is_gap(a: &Point, b: &Point) -> bool {
    let d = stats::haversine_m(a, b);
    match (a.time, b.time) {
        (Some(ta), Some(tb)) => {
            let dt = (tb - ta).abs();
            (d > GAP_MIN_M && dt > GAP_MIN_MS)
                || (d > GAP_FLIGHT_M && d / (dt.max(1000) as f64 / 1000.0) > GAP_FLIGHT_SPEED_MS)
        }
        _ => d > GAP_MIN_M_UNTIMED,
    }
}

pub(crate) const HOUR_MS: i64 = 3_600_000;

/// Boşluklarda bölünmüş parçalardan saatlik mesafe ve hareket süresi.
/// Bir adım, başladığı saate yazılır. Zamanlı noktası olan her saat listede
/// bulunur.
pub(crate) fn hourly_buckets(pieces: &[&[Point]], cfg: &StatsConfig) -> Vec<[f64; 3]> {
    let mut map: std::collections::BTreeMap<i64, (f64, i64)> = Default::default();
    for piece in pieces {
        for w in piece.windows(2) {
            let (Some(t0), Some(t1)) = (w[0].time, w[1].time) else {
                continue;
            };
            let hour = t0.div_euclid(HOUR_MS) * HOUR_MS;
            let step = stats::haversine_m(&w[0], &w[1]);
            let e = map.entry(hour).or_default();
            e.0 += step;
            let dt = t1 - t0;
            if dt > 0
                && dt <= stats::MAX_MOVING_GAP_MS
                && step / (dt as f64 / 1000.0) >= cfg.moving_speed_ms
            {
                e.1 += dt;
            }
        }
        // Zamanlı her nokta o saatte kayıt olduğunu gösterir: tek noktalık
        // parça ya da yalnızca parçanın son noktasının düştüğü saat de
        // (mesafesi 0 olsa bile) listede yer alır.
        for p in piece.iter() {
            if let Some(t) = p.time {
                map.entry(t.div_euclid(HOUR_MS) * HOUR_MS).or_default();
            }
        }
    }
    map.into_iter()
        .map(|(h, (d, m))| [h as f64, (d * 10.0).round() / 10.0, m as f64])
        .collect()
}

/// `hours` içindeki her saatin (saat başı, Unix ms) asıl segmentlerde o saate
/// düşen ilk noktası `[lon, lat]`. Noktası bulunamayan saat atlanır; sıra
/// `hours` ile aynıdır.
pub fn hour_first_points(gpx: &Gpx, hours: &[[f64; 3]]) -> Vec<(i64, [f64; 2])> {
    // Uçarken (ya da çok hızlı giderken) alınan noktalar o yerde bulunulduğunu
    // göstermez (ör. inişte bir sınırın üstünden geçmek); bunlar atlanır.
    const GROUND_SPEED_MS: f64 = 150.0 / 3.6;
    let mut first: std::collections::HashMap<i64, [f64; 2]> = Default::default();
    let (pieces, _) = split_at_gaps(&primary_segments(gpx));
    for piece in pieces {
        for (i, p) in piece.iter().enumerate() {
            let Some(t) = p.time else { continue };
            let hour = t.div_euclid(HOUR_MS) * HOUR_MS;
            if first.contains_key(&hour) {
                continue;
            }
            let fast = |q: &Point| match (p.time, q.time) {
                (Some(a), Some(b)) => {
                    let dt = ((b - a).abs().max(1000)) as f64 / 1000.0;
                    stats::haversine_m(p, q) / dt > GROUND_SPEED_MS
                }
                _ => false,
            };
            let before = i.checked_sub(1).map(|j| &piece[j]);
            let after = piece.get(i + 1);
            if before.is_some_and(fast) || after.is_some_and(fast) {
                continue;
            }
            first.insert(hour, [p.lon, p.lat]);
        }
    }
    hours
        .iter()
        .filter_map(|h| {
            let hour = h[0] as i64;
            first.get(&hour).map(|&p| (hour, p))
        })
        .collect()
}

/// Segmentleri kayıt boşluklarında parçalara böler.
pub fn split_at_gaps<'a>(segments: &[&'a [Point]]) -> (Vec<&'a [Point]>, Vec<Gap>) {
    let mut pieces = Vec::new();
    let mut gaps = Vec::new();
    for seg in segments {
        let mut start = 0;
        for i in 1..seg.len() {
            let (a, b) = (&seg[i - 1], &seg[i]);
            if is_gap(a, b) {
                pieces.push(&seg[start..i]);
                gaps.push(Gap {
                    from: [round6(a.lon), round6(a.lat)],
                    to: [round6(b.lon), round6(b.lat)],
                    start: a.time,
                    end: b.time,
                    distance_m: stats::haversine_m(a, b),
                });
                start = i;
            }
        }
        pieces.push(&seg[start..]);
    }
    (pieces, gaps)
}

pub(crate) fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

/// Segmentlerin istatistiği; kayıt boşlukları (uçuş, sinyal kaybı) segment
/// sınırı sayılır: mesafeye, hareket süresine ve hıza katılmaz. Segment
/// sayısı dosyadaki segmentlerindir.
pub fn track_stats(segments: &[&[Point]], cfg: &StatsConfig) -> Stats {
    let (pieces, _) = split_at_gaps(segments);
    let mut s = compute_stats(pieces.iter().copied(), cfg);
    s.segment_count = segments.iter().filter(|s| !s.is_empty()).count();
    s
}
