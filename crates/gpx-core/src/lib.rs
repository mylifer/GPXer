//! GPXer çekirdeği: GPX dosyalarını okur, özetler ve arayüzün ihtiyaç
//! duyduğu hafif veri yapılarını üretir.
//!
//! Tasarım notu: yüzlerce dosyanın aynı anda açık olabilmesi için uygulama
//! her dosyadan yalnızca [`FileSummary`] (istatistik + sadeleştirilmiş çizgi)
//! tutar. Grafik gibi tam çözünürlük gereken veriler ([`Detail`]) seçildiğinde
//! dosya yeniden okunarak üretilir.

pub mod ops;
pub mod parse;
pub mod simplify;
pub mod stats;
pub mod write;

use parse::{Gpx, Point};
use serde::{Deserialize, Serialize};
use std::path::Path;

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
    pub waypoints: Vec<WaypointOut>,
    /// Kaydın başladığı yerin IANA saat dilimi (ör. "Europe/Istanbul").
    /// Çekirdek doldurmaz; uygulama katmanı konumdan bulur.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Başlangıç noktası [lon, lat].
    #[serde(default)]
    pub start: Option<[f64; 2]>,
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
    /// Her örneğin dosyadaki asıl nokta sırası (iz/rota segmentleri uç uca
    /// eklenmiş kabul edilir). Kırpma, bölme ve aralık istatistiğinde kullanılır.
    pub idx: Vec<u32>,
    /// Sensör verileri; dosyada hiç yoksa boş bırakılır.
    pub hr: Vec<Option<f32>>,
    pub cad: Vec<Option<f32>>,
    pub power: Vec<Option<f32>>,
    pub temp: Vec<Option<f32>>,
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

fn round6(v: f64) -> f64 {
    (v * 1e6).round() / 1e6
}

pub fn summarize(
    gpx: &Gpx,
    path: &str,
    file_size: u64,
    cfg: &StatsConfig,
) -> Result<FileSummary, LoadError> {
    let segments = primary_segments(gpx);
    if segments.is_empty() && gpx.waypoints.is_empty() {
        return Err(LoadError::Empty);
    }
    let mut stats = compute_stats(segments.iter().copied(), cfg);
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

    let simplified: Vec<Vec<Point>> = segments
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
    })
}

/// Asıl noktaların `[start, end]` (dahil) aralığının istatistiği. Sıra
/// numaraları [`Detail::idx`] ile aynıdır.
pub fn range_stats(gpx: &Gpx, start: usize, end: usize, cfg: &StatsConfig) -> Stats {
    let parts = ops::slice_segments(&primary_segments(gpx), start, end);
    compute_stats(parts.iter().map(|s| s.as_slice()), cfg)
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

pub fn build_detail(gpx: &Gpx) -> Detail {
    let segments = primary_segments(gpx);
    let total: usize = segments.iter().map(|s| s.len()).sum();
    let mut d = Detail::default();
    let mut dist_acc = 0.0;
    let mut all: Vec<&Point> = Vec::with_capacity(total);
    let mut dist = Vec::with_capacity(total);
    let mut speed = Vec::with_capacity(total);

    for seg in &segments {
        let start_idx = all.len();
        for (i, p) in seg.iter().enumerate() {
            if i > 0 {
                dist_acc += haversine_m(&seg[i - 1], p);
            }
            all.push(p);
            dist.push(dist_acc);
        }
        // Hız: her noktanın çevresindeki ~±15 sn'lik pencereye göre.
        for i in 0..seg.len() {
            let Some(ti) = seg[i].time else {
                speed.push(None);
                continue;
            };
            let mut a = i;
            while a > 0 && seg[a - 1].time.is_some_and(|t| ti - t <= 15_000) {
                a -= 1;
            }
            let mut b = i;
            while b + 1 < seg.len() && seg[b + 1].time.is_some_and(|t| t - ti <= 15_000) {
                b += 1;
            }
            let (ta, tb) = (seg[a].time.unwrap(), seg[b].time.unwrap());
            if tb > ta {
                let meters = dist[start_idx + b] - dist[start_idx + a];
                speed.push(Some((meters / ((tb - ta) as f64 / 1000.0) * 3.6) as f32));
            } else {
                speed.push(None);
            }
        }
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

pub fn read_gpx_file(path: &Path) -> Result<(Gpx, u64), LoadError> {
    let bytes = std::fs::read(path).map_err(LoadError::Io)?;
    let size = bytes.len() as u64;
    let gpx = parse_gpx(&bytes).map_err(LoadError::Parse)?;
    Ok((gpx, size))
}

pub fn load_summary(path: &Path, cfg: &StatsConfig) -> Result<FileSummary, LoadError> {
    let (gpx, size) = read_gpx_file(path)?;
    summarize(&gpx, &path.to_string_lossy(), size, cfg)
}

pub fn load_detail(path: &Path) -> Result<Detail, LoadError> {
    let (gpx, _) = read_gpx_file(path)?;
    Ok(build_detail(&gpx))
}

#[cfg(test)]
mod tests;
