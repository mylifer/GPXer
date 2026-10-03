//! Asıl segmentler, kayıt boşlukları ve saatlik toplamlar.

use crate::parse::{Gpx, Point};
use crate::stats::{self, Stats, StatsConfig};
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

/// Kaydın boşluk kuralı. Süre eşiği kaydın nokta sıklığına uyar: seyrek
/// kayıtta (ör. 10–15 dakikada bir nokta alan konum geçmişi) her adım
/// boşluk sayılmasın diye eşik, olağan aralığın 3 katından az olmaz.
#[derive(Debug, Clone, Copy)]
pub(crate) struct GapRule {
    min_ms: i64,
}

impl GapRule {
    /// Nokta sıklığından bağımsız kural (10 dakika ve 2 km): harita çizgisi
    /// bununla kesilir. Seyrek kayıtta uyarlanmış kural mesafe ve süre için
    /// doğru, ama 10-15 dakikalık her sürüş adımı haritada şehri kat eden düz
    /// bir çizgi olarak görünüyordu.
    pub(crate) fn fixed() -> Self {
        GapRule { min_ms: GAP_MIN_MS }
    }

    pub(crate) fn of(segments: &[&[Point]]) -> Self {
        // Olağan aralık: zaman adımlarının ortancası (en çok 20 bin örnek).
        let mut steps: Vec<i64> = segments
            .iter()
            .flat_map(|s| s.windows(2))
            .filter_map(|w| Some(w[1].time? - w[0].time?))
            .filter(|&dt| dt > 0)
            .take(20_000)
            .collect();
        let median = if steps.is_empty() {
            0
        } else {
            let mid = steps.len() / 2;
            *steps.select_nth_unstable(mid).1
        };
        GapRule {
            min_ms: GAP_MIN_MS.max(3 * median),
        }
    }

    /// Hareket süresine sayılabilecek en uzun adım: boşluk sayılmayan her
    /// adım (seyrek kayıtta 10 dakikadan uzun olanlar da) hareket olabilir;
    /// yoksa mesafesi sayılıp süresi sayılmıyor, hız şişiyordu.
    pub(crate) fn max_moving_ms(&self) -> i64 {
        self.min_ms
    }

    pub(crate) fn is_gap(&self, a: &Point, b: &Point) -> bool {
        is_gap_with(a, b, self.min_ms)
    }
}

fn is_gap_with(a: &Point, b: &Point, min_ms: i64) -> bool {
    let d = stats::haversine_m(a, b);
    match (a.time, b.time) {
        (Some(ta), Some(tb)) => {
            let dt = (tb - ta).abs();
            (d > GAP_MIN_M && dt > min_ms)
                || (d > GAP_FLIGHT_M && d / (dt.max(1000) as f64 / 1000.0) > GAP_FLIGHT_SPEED_MS)
        }
        _ => d > GAP_MIN_M_UNTIMED,
    }
}

pub(crate) const HOUR_MS: i64 = 3_600_000;

/// Boşluklarda bölünmüş parçalardan saatlik mesafe ve hareket süresi.
/// Bir adım, başladığı saate yazılır. Zamanlı noktası olan her saat listede
/// bulunur.
pub(crate) fn hourly_buckets(
    pieces: &[&[Point]],
    cfg: &StatsConfig,
    max_moving_ms: i64,
) -> Vec<[f64; 3]> {
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
            if dt > 0 && dt <= max_moving_ms && step / (dt as f64 / 1000.0) >= cfg.moving_speed_ms {
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
    // Hız en az bu kadar aralıkla ölçülür: aynı yerde tekrarlanan noktalar
    // (0 m) ya da segment sınırları uçuşu gizlemesin.
    const WINDOW_MS: i64 = 30_000;
    // Tüm segmentler tek sıra: komşular segment sınırlarını ve boşlukları aşar.
    let pts: Vec<&Point> = primary_segments(gpx)
        .into_iter()
        .flatten()
        .filter(|p| p.time.is_some())
        .collect();
    let fast = |p: &Point, q: &Point| {
        let dt = (q.time.unwrap_or(0) - p.time.unwrap_or(0)).abs().max(1000) as f64 / 1000.0;
        stats::haversine_m(p, q) / dt > GROUND_SPEED_MS
    };
    let mut first: std::collections::HashMap<i64, [f64; 2]> = Default::default();
    for (i, p) in pts.iter().enumerate() {
        let t = p.time.unwrap_or(0);
        let hour = t.div_euclid(HOUR_MS) * HOUR_MS;
        if first.contains_key(&hour) {
            continue;
        }
        // Önceki ve sonraki, en az WINDOW_MS uzaktaki (yoksa en uzak) komşu.
        let before = pts[..i]
            .iter()
            .rev()
            .find(|q| t - q.time.unwrap_or(0) >= WINDOW_MS)
            .or(pts[..i].first());
        let after = pts[i + 1..]
            .iter()
            .find(|q| q.time.unwrap_or(0) - t >= WINDOW_MS)
            .or(pts[i + 1..].last());
        // En yakın komşu da hızlıysa (saniyelik kayıtta uçak).
        let near_before = i.checked_sub(1).map(|j| pts[j]);
        let near_after = pts.get(i + 1).copied();
        if [before.copied(), after.copied(), near_before, near_after]
            .into_iter()
            .flatten()
            .any(|q| fast(p, q))
        {
            continue;
        }
        first.insert(hour, [p.lon, p.lat]);
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
    split_with(segments, &GapRule::of(segments))
}

/// [`split_at_gaps`], verilen boşluk kuralıyla (aralık istatistiği tüm
/// kaydın kuralını kullanır).
pub(crate) fn split_with<'a>(
    segments: &[&'a [Point]],
    rule: &GapRule,
) -> (Vec<&'a [Point]>, Vec<Gap>) {
    let gap = |a: &Point, b: &Point| Gap {
        from: [round6(a.lon), round6(a.lat)],
        to: [round6(b.lon), round6(b.lat)],
        start: a.time,
        end: b.time,
        distance_m: stats::haversine_m(a, b),
        from_place: None,
        to_place: None,
    };
    let mut pieces = Vec::new();
    let mut gaps = Vec::new();
    let mut prev_last: Option<&Point> = None;
    for seg in segments {
        // Segmentler arasındaki sıçrama da boşluktur (ör. konum geçmişinde
        // her birkaç noktada yeni segment: uçuş iki segment arasına düşer).
        // Segmentler zaten ayrı çizildiğinden parça bölmeye gerek yok.
        if let (Some(a), Some(b)) = (prev_last, seg.first()) {
            if rule.is_gap(a, b) {
                gaps.push(gap(a, b));
            }
        }
        let mut start = 0;
        for i in 1..seg.len() {
            let (a, b) = (&seg[i - 1], &seg[i]);
            if rule.is_gap(a, b) {
                pieces.push(&seg[start..i]);
                gaps.push(gap(a, b));
                start = i;
            }
        }
        pieces.push(&seg[start..]);
        prev_last = seg.last().or(prev_last);
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
    track_stats_with(segments, cfg, &GapRule::of(segments))
}

pub(crate) fn track_stats_with(segments: &[&[Point]], cfg: &StatsConfig, rule: &GapRule) -> Stats {
    let (pieces, _) = split_with(segments, rule);
    let mut s = stats::compute_stats_capped(pieces.iter().copied(), cfg, rule.max_moving_ms());
    s.segment_count = segments.iter().filter(|s| !s.is_empty()).count();
    s
}
