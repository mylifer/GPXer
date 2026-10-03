//! GPXer çekirdeği: GPX dosyalarını okur, özetler ve arayüzün ihtiyaç
//! duyduğu hafif veri yapılarını üretir.
//!
//! Tasarım notu: yüzlerce dosyanın aynı anda açık olabilmesi için uygulama
//! her dosyadan yalnızca [`FileSummary`] (istatistik + sadeleştirilmiş çizgi)
//! tutar. Grafik gibi tam çözünürlük gereken veriler ([`Detail`]) seçildiğinde
//! dosya yeniden okunarak üretilir.

pub mod analysis;
pub mod formats;
pub mod ops;
pub mod parse;
pub mod simplify;
pub mod stats;
pub mod write;

use parse::{Gpx, Point};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub use analysis::{Activity, Stop};
pub use parse::{parse_gpx, ParseError};
pub use stats::{compute_stats, haversine_m, Stats, StatsConfig};

/// Harita çizgisi sadeleştirme toleransı (metre).
pub const MAP_TOLERANCE_M: f64 = 4.0;
/// Grafik için gönderilecek en fazla nokta sayısı.
pub const PROFILE_MAX_POINTS: usize = 4000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaypointOut {
    pub lat: f64,
    pub lon: f64,
    pub ele: Option<f32>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub file_name: String,
    /// GPX içindeki ad (metadata ya da ilk track adı).
    pub name: Option<String>,
    pub file_size: u64,
    pub track_count: usize,
    pub route_count: usize,
    pub stats: Stats,
    /// Sadeleştirilmiş çizgiler, her biri [lon, lat] dizisi.
    pub lines: Vec<Vec<[f64; 2]>>,
    /// `lines` ile aynı düzende nokta zamanları (Unix ms). Dosyada hiç zaman
    /// bilgisi yoksa boş bırakılır.
    pub times: Vec<Vec<Option<i64>>>,
    /// Kayıt boşlukları (uzun süre ya da uzun mesafe nokta yok: uçuş, sinyal
    /// kaybı). `lines` bu yerlerde bölünür; harita boşluğu ayrıca gösterir.
    #[serde(default)]
    pub gaps: Vec<Gap>,
    /// Saatlik toplamlar `[saat başı (Unix ms, UTC), mesafe (m), hareket (ms)]`;
    /// yalnızca kayıt olan saatler. Çok günlük kayıtların takvimde, tarih
    /// filtresinde ve özette gün gün sayılması için (arayüz kendi saat
    /// dilimine göre günlere toplar).
    #[serde(default)]
    pub hours: Vec<[f64; 3]>,
    pub waypoints: Vec<WaypointOut>,
    /// Kaydın başladığı yerin IANA saat dilimi (ör. "Europe/Istanbul").
    /// Çekirdek doldurmaz; uygulama katmanı konumdan bulur.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Başlangıç noktası [lon, lat].
    #[serde(default)]
    pub start: Option<[f64; 2]>,
    /// Bitiş noktası [lon, lat].
    #[serde(default)]
    pub end: Option<[f64; 2]>,
    /// Başlangıç ve bitiş yerinin adı (uygulama katmanı doldurur).
    #[serde(default)]
    pub start_place: Option<String>,
    #[serde(default)]
    pub end_place: Option<String>,
    /// Saat saat geçilen yerler `[saat başı (Unix ms), ülke kodu, yer adı]`:
    /// `hours` içindeki her saatin ilk noktasının yeri; yalnızca bir önceki
    /// girdiden farklıysa eklenir. Uygulama katmanı doldurur
    /// ([`hour_first_points`]).
    #[serde(default)]
    pub visits: Vec<(i64, String, String)>,
    /// Etkinlik türü (seçilmişse o, değilse tahmin).
    #[serde(default)]
    pub activity: Activity,
    /// Türü kullanıcı mı seçti.
    #[serde(default)]
    pub activity_set: bool,
    #[serde(default)]
    pub stops: Vec<Stop>,
    /// Ayıklanan GPS sıçraması ve kopuk uç noktası sayısı.
    #[serde(default)]
    pub removed_points: usize,
    /// Uzun duraklamalar tek noktaya indirilirken atılan nokta sayısı.
    #[serde(default)]
    pub collapsed_points: usize,
}

/// Seçili dosyanın grafik verisi, sütun sütun (uPlot formatına uygun).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    /// Başlangıçtan itibaren kümülatif mesafe (m).
    pub dist: Vec<f64>,
    pub ele: Vec<Option<f32>>,
    /// Yumuşatılmış anlık hız (km/sa).
    pub speed: Vec<Option<f32>>,
    pub time: Vec<Option<i64>>,
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    /// Her örneğin hazırlanmış kayıttaki ([`prepare`]) asıl nokta sırası
    /// (iz/rota segmentleri uç uca eklenmiş kabul edilir). Aralık istatistiği
    /// aynı sırayı kullanır; kırpma ve bölmede [`Prepared::raw_index`] ile ham
    /// dosyadaki sıraya çevrilir.
    pub idx: Vec<u32>,
    /// Sensör verileri; dosyada hiç yoksa boş bırakılır.
    pub hr: Vec<Option<f32>>,
    pub cad: Vec<Option<f32>>,
    pub power: Vec<Option<f32>>,
    pub temp: Vec<Option<f32>>,
    /// Ardından kayıt boşluğu gelen örneklerin sırası: `k` listedeyse `k` ile
    /// `k + 1` arasındaki asıl noktalarda (seyreltmede atlananlar dahil) bir
    /// boşluk ([`is_gap`]) vardır. Harita çizgiyi burada keser.
    pub gap_after: Vec<u32>,
}

#[derive(Debug)]
pub enum LoadError {
    Io(std::io::Error),
    Parse(ParseError),
    Empty,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(e) => write!(f, "Dosya okunamadı: {e}"),
            LoadError::Parse(e) => write!(f, "{e}"),
            LoadError::Empty => f.write_str("Dosyada rota, iz ya da nokta bulunamadı"),
        }
    }
}

impl std::error::Error for LoadError {}

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

/// İz üzerinde nokta olmayan bir aralık.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    /// Boşluktan önceki ve sonraki nokta [lon, lat].
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub distance_m: f64,
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

const HOUR_MS: i64 = 3_600_000;

/// Boşluklarda bölünmüş parçalardan saatlik mesafe ve hareket süresi.
/// Bir adım, başladığı saate yazılır. Zamanlı noktası olan her saat listede
/// bulunur.
fn hourly_buckets(pieces: &[&[Point]], cfg: &StatsConfig) -> Vec<[f64; 3]> {
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

fn round6(v: f64) -> f64 {
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

/// Kaydın türünü (seçilmemişse tahmin ederek) ve o türe göre kullanılacak
/// eşikleri belirler.
pub fn effective_config(
    gpx: &Gpx,
    cfg: &StatsConfig,
    chosen: Option<Activity>,
) -> (StatsConfig, Activity) {
    let activity =
        chosen.unwrap_or_else(|| analysis::classify(&track_stats(&primary_segments(gpx), cfg)));
    let eff = if cfg.per_type {
        activity.thresholds(cfg)
    } else {
        *cfg
    };
    (eff, activity)
}

/// Ön işlemlerden ([`prepare`]) geçmiş kayıt.
#[derive(Debug, Clone, Default)]
pub struct Prepared {
    pub gpx: Gpx,
    /// Her asıl segment için kalan noktaların ham segmentteki sırası.
    pub map: Vec<Vec<u32>>,
    /// Ham kayıttaki asıl segmentlerin nokta sayıları.
    pub raw_lens: Vec<usize>,
    /// Ayıklanan sıçrama / kopuk uç noktası sayısı.
    pub removed: usize,
    /// Duraklamalar tek noktaya indirilirken atılan nokta sayısı.
    pub collapsed: usize,
}

impl Prepared {
    /// Hazırlanmış kayıttaki `i`. asıl noktanın ham kayıttaki sırası.
    pub fn raw_index(&self, i: usize) -> Option<usize> {
        let mut rest = i;
        let mut offset = 0;
        for (m, len) in self.map.iter().zip(&self.raw_lens) {
            if rest < m.len() {
                return Some(offset + m[rest] as usize);
            }
            rest -= m.len();
            offset += len;
        }
        None
    }

    /// Hazırlanmış kayıttaki asıl nokta sayısı.
    pub fn len(&self) -> usize {
        self.map.iter().map(|m| m.len()).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Okunan kayda ayarların gerektirdiği ön işlemleri uygular (sıçrama
/// temizliği, duraklamaları tek noktaya indirme). Kalan noktaların ham
/// kayıttaki sıraları tutulur.
pub fn prepare(mut gpx: Gpx, cfg: &StatsConfig) -> Prepared {
    let (mut removed, mut collapsed) = (0, 0);
    let source = if gpx.tracks.is_empty() {
        &mut gpx.routes
    } else {
        &mut gpx.tracks
    };
    let mut map = Vec::new();
    let mut raw_lens = Vec::new();
    for seg in source.iter_mut().flat_map(|t| t.segments.iter_mut()) {
        raw_lens.push(seg.len());
        let mut idx: Vec<u32> = (0..seg.len() as u32).collect();
        if cfg.clean_spikes {
            removed += analysis::clean_segment_indexed(seg, &mut idx);
            if cfg.collapse_stays {
                collapsed += analysis::collapse_segment_stays_indexed(seg, &mut idx);
            }
        }
        map.push(idx);
    }
    Prepared {
        gpx,
        map,
        raw_lens,
        removed,
        collapsed,
    }
}

pub fn summarize(
    gpx: &Gpx,
    path: &str,
    file_size: u64,
    cfg: &StatsConfig,
) -> Result<FileSummary, LoadError> {
    summarize_with(gpx, path, file_size, cfg, None)
}

/// `gpx` [`prepare`] edilmiş olmalıdır.
pub fn summarize_with(
    gpx: &Gpx,
    path: &str,
    file_size: u64,
    cfg: &StatsConfig,
    chosen: Option<Activity>,
) -> Result<FileSummary, LoadError> {
    let segments = primary_segments(gpx);
    if segments.is_empty() && gpx.waypoints.is_empty() {
        return Err(LoadError::Empty);
    }
    let (eff, activity) = effective_config(gpx, cfg, chosen);
    let mut stats = track_stats(&segments, &eff);

    if stats.start_time.is_none() {
        stats.start_time = gpx.time;
    }
    if stats.bbox.is_none() && !gpx.waypoints.is_empty() {
        let mut b = [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ];
        for w in &gpx.waypoints {
            b = [
                b[0].min(w.point.lon),
                b[1].min(w.point.lat),
                b[2].max(w.point.lon),
                b[3].max(w.point.lat),
            ];
        }
        stats.bbox = Some(b);
    }

    let (pieces, gaps) = split_at_gaps(&segments);
    let hours = hourly_buckets(&pieces, &eff);
    let simplified: Vec<Vec<Point>> = pieces
        .iter()
        .map(|seg| simplify::douglas_peucker(seg, MAP_TOLERANCE_M))
        .filter(|l| l.len() >= 2)
        .collect();
    let lines = simplified
        .iter()
        .map(|l| l.iter().map(|p| [round6(p.lon), round6(p.lat)]).collect())
        .collect();
    let times = if simplified.iter().flatten().any(|p| p.time.is_some()) {
        simplified
            .iter()
            .map(|l| l.iter().map(|p| p.time).collect())
            .collect()
    } else {
        Vec::new()
    };

    let file_name = Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_owned());

    let name = gpx.name.clone().or_else(|| {
        gpx.tracks
            .iter()
            .chain(&gpx.routes)
            .find_map(|t| t.name.clone())
    });

    Ok(FileSummary {
        path: path.to_owned(),
        file_name,
        name,
        file_size,
        track_count: gpx.tracks.len(),
        route_count: gpx.routes.len(),
        stats,
        lines,
        times,
        gaps,
        hours,
        waypoints: gpx
            .waypoints
            .iter()
            .map(|w| WaypointOut {
                lat: w.point.lat,
                lon: w.point.lon,
                ele: w.point.ele,
                name: w.name.clone(),
            })
            .collect(),
        time_zone: None,
        start: segments
            .first()
            .and_then(|s| s.first())
            .or_else(|| gpx.waypoints.first().map(|w| &w.point))
            .map(|p| [p.lon, p.lat]),
        end: segments
            .last()
            .and_then(|s| s.last())
            .or_else(|| gpx.waypoints.last().map(|w| &w.point))
            .map(|p| [p.lon, p.lat]),
        start_place: None,
        end_place: None,
        visits: Vec::new(),
        activity,
        activity_set: chosen.is_some(),
        stops: analysis::detect_stops(segments.iter().copied()),
        removed_points: 0,
        collapsed_points: 0,
    })
}

/// Asıl noktaların `[start, end]` (dahil) aralığının istatistiği. Sıra
/// numaraları [`Detail::idx`] ile aynıdır.
pub fn range_stats(gpx: &Gpx, start: usize, end: usize, cfg: &StatsConfig) -> Stats {
    let parts = ops::slice_segments(&primary_segments(gpx), start, end);
    let parts: Vec<&[Point]> = parts.iter().map(|s| s.as_slice()).collect();
    track_stats(&parts, cfg)
}

/// Dosyanın içeriğine göre parmak izi: iz/rota noktalarının konum ve
/// zamanları ile işaret noktalarından hesaplanır. Aynı kaydın farklı adla ya
/// da farklı biçimlendirmeyle kaydedilmiş kopyaları aynı değeri verir.
/// Sürümler arasında değişmemesi için FNV-1a kullanılır.
pub fn fingerprint(gpx: &Gpx) -> u64 {
    const PRIME: u64 = 0x100_0000_01b3;
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for b in bytes {
            h ^= u64::from(*b);
            h = h.wrapping_mul(PRIME);
        }
    };
    for seg in primary_segments(gpx) {
        eat(b"S");
        for p in seg {
            eat(&p.lat.to_le_bytes());
            eat(&p.lon.to_le_bytes());
            eat(&p.time.unwrap_or(i64::MIN).to_le_bytes());
        }
    }
    for w in &gpx.waypoints {
        eat(b"W");
        eat(&w.point.lat.to_le_bytes());
        eat(&w.point.lon.to_le_bytes());
    }
    h
}

/// Hız penceresinin yarı genişliği (ms).
const SPEED_HALF_WINDOW_MS: i64 = 15_000;

/// Her noktanın çevresindeki ~±15 sn'lik pencereye göre hız (km/sa).
/// `pts` boşluksuz tek bir parçadır; `dist` kümülatif mesafe. İki işaretçi
/// yalnızca ileri gider: eşit ya da geriye giden zamanlarda da doğrusal.
fn window_speeds(pts: &[&Point], dist: &[f64], out: &mut [Option<f32>]) {
    let n = pts.len();
    let t = |k: usize| pts[k].time.unwrap_or_default();
    let mut i = 0;
    while i < n {
        if pts[i].time.is_none() {
            i += 1;
            continue;
        }
        // Zaman bilgili kesintisiz dizi: i..end.
        let mut end = i;
        while end < n && pts[end].time.is_some() {
            end += 1;
        }
        let (mut lo, mut hi) = (i, i);
        for (k, slot) in out.iter_mut().enumerate().take(end).skip(i) {
            let tk = t(k);
            hi = hi.max(k);
            while hi + 1 < end && t(hi + 1) - tk <= SPEED_HALF_WINDOW_MS {
                hi += 1;
            }
            while lo < k && tk - t(lo) > SPEED_HALF_WINDOW_MS {
                lo += 1;
            }
            let (ta, tb) = (t(lo), t(hi));
            if tb > ta {
                let meters = dist[hi] - dist[lo];
                *slot = Some((meters / ((tb - ta) as f64 / 1000.0) * 3.6) as f32);
            }
        }
        i = end;
    }
}

/// `gpx` [`prepare`] edilmiş olmalıdır. Kayıt boşluklarında mesafe artmaz ve
/// hız penceresi boşluğu aşmaz.
pub fn build_detail(gpx: &Gpx) -> Detail {
    let segments = primary_segments(gpx);
    let total: usize = segments.iter().map(|s| s.len()).sum();
    let mut d = Detail::default();
    let mut dist_acc = 0.0;
    let mut all: Vec<&Point> = Vec::with_capacity(total);
    let mut dist = Vec::with_capacity(total);
    // Boşluksuz parçaların [başlangıç, bitiş) aralıkları.
    let mut pieces = Vec::new();
    // Boşluktan sonraki ilk noktanın `all` içindeki sırası (artan).
    let mut gap_at = Vec::new();

    for seg in &segments {
        let base = all.len();
        let mut piece_start = base;
        for (i, p) in seg.iter().enumerate() {
            if i > 0 {
                if is_gap(&seg[i - 1], p) {
                    pieces.push((piece_start, base + i));
                    piece_start = base + i;
                    gap_at.push(base + i);
                } else {
                    dist_acc += haversine_m(&seg[i - 1], p);
                }
            }
            all.push(p);
            dist.push(dist_acc);
        }
        pieces.push((piece_start, all.len()));
    }
    let mut speed = vec![None; total];
    for (a, b) in pieces {
        window_speeds(&all[a..b], &dist[a..b], &mut speed[a..b]);
    }

    let y: Vec<f64> = all
        .iter()
        .map(|p| p.ele.map_or(0.0, |e| e as f64))
        .collect();
    let idx = simplify::lttb_indices(&dist, &y, PROFILE_MAX_POINTS);
    let has = |f: fn(&Point) -> Option<f32>| all.iter().any(|p| f(p).is_some());
    let (has_hr, has_cad, has_power, has_temp) = (
        has(|p| p.hr),
        has(|p| p.cad),
        has(|p| p.power),
        has(|p| p.temp),
    );
    // Ardışık iki örnek (a, b] arasında bir boşluk başlıyorsa a'dan sonra
    // kesilir; her iki liste de artan olduğundan tek geçişte bulunur.
    let mut g = 0;
    for (k, w) in idx.windows(2).enumerate() {
        while g < gap_at.len() && gap_at[g] <= w[0] {
            g += 1;
        }
        if g < gap_at.len() && gap_at[g] <= w[1] {
            d.gap_after.push(k as u32);
        }
    }
    for i in idx {
        let p = all[i];
        d.dist.push(dist[i]);
        d.ele.push(p.ele);
        d.speed.push(speed[i]);
        d.time.push(p.time);
        d.lat.push(p.lat);
        d.lon.push(p.lon);
        d.idx.push(i as u32);
        if has_hr {
            d.hr.push(p.hr);
        }
        if has_cad {
            d.cad.push(p.cad);
        }
        if has_power {
            d.power.push(p.power);
        }
        if has_temp {
            d.temp.push(p.temp);
        }
    }
    d
}

/// Dosyayı uzantısına göre (GPX, FIT, TCX, KML) okur; ham haliyle döndürür.
pub fn read_gpx_file(path: &Path) -> Result<(Gpx, u64), LoadError> {
    let bytes = std::fs::read(path).map_err(LoadError::Io)?;
    let size = bytes.len() as u64;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_default();
    let gpx = formats::parse_any(&ext, &bytes).map_err(LoadError::Parse)?;
    Ok((gpx, size))
}

/// Okur ve ayarlara göre hazırlar (sıçrama temizliği).
pub fn read_prepared(path: &Path, cfg: &StatsConfig) -> Result<(Prepared, u64), LoadError> {
    let (gpx, size) = read_gpx_file(path)?;
    Ok((prepare(gpx, cfg), size))
}

pub fn load_summary(path: &Path, cfg: &StatsConfig) -> Result<FileSummary, LoadError> {
    let (p, size) = read_prepared(path, cfg)?;
    let mut s = summarize(&p.gpx, &path.to_string_lossy(), size, cfg)?;
    s.removed_points = p.removed;
    s.collapsed_points = p.collapsed;
    Ok(s)
}

pub fn load_detail(path: &Path, cfg: &StatsConfig) -> Result<Detail, LoadError> {
    let (p, _) = read_prepared(path, cfg)?;
    Ok(build_detail(&p.gpx))
}

#[cfg(test)]
mod tests;
