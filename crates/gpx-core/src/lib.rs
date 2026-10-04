//! GPXer çekirdeği: GPX dosyalarını okur, özetler ve arayüzün ihtiyaç
//! duyduğu hafif veri yapılarını üretir.
//!
//! Tasarım notu: yüzlerce dosyanın aynı anda açık olabilmesi için uygulama
//! her dosyadan yalnızca [`FileSummary`] (istatistik + sadeleştirilmiş çizgi)
//! tutar. Grafik gibi tam çözünürlük gereken veriler ([`Detail`]) seçildiğinde
//! dosya yeniden okunarak üretilir.

pub mod analysis;
mod detail;
pub mod formats;
pub mod google;
pub mod ops;
pub mod parse;
mod segments;
pub mod simplify;
pub mod stats;
mod types;
pub mod write;

use parse::{Gpx, Point};
use std::path::Path;

pub use analysis::{Activity, Stop};
pub use detail::build_detail;
pub use parse::{parse_gpx, ParseError};
pub use segments::{hour_first_points, primary_segments, split_at_gaps, track_stats};
pub(crate) use segments::{hourly_buckets, round6, GapRule};
pub use stats::{compute_stats, haversine_m, Stats, StatsConfig};
pub use types::{Detail, FileSummary, Gap, LoadError, WaypointOut};

/// Harita çizgisi sadeleştirme toleransı (metre).
pub const MAP_TOLERANCE_M: f64 = 4.0;
/// Grafik için gönderilecek en fazla nokta sayısı.
pub const PROFILE_MAX_POINTS: usize = 4000;

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
    // Önce bütünüyle yanlış yerdeki segmentler (ham veride: segment içi
    // temizlik onları kısaltmadan).
    let teleported: Vec<usize> = if cfg.clean_spikes {
        let view: Vec<&[Point]> = source
            .iter()
            .flat_map(|t| t.segments.iter().map(|s| s.as_slice()))
            .collect();
        analysis::teleport_segments(&view)
    } else {
        Vec::new()
    };
    let mut map = Vec::new();
    let mut raw_lens = Vec::new();
    for (i, seg) in source
        .iter_mut()
        .flat_map(|t| t.segments.iter_mut())
        .enumerate()
    {
        raw_lens.push(seg.len());
        let mut idx: Vec<u32> = (0..seg.len() as u32).collect();
        if teleported.contains(&i) {
            removed += seg.len();
            seg.clear();
            idx.clear();
        } else if cfg.clean_spikes {
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

    let rule = GapRule::of(&segments);
    let (pieces, gaps) = segments::split_with(&segments, &rule);
    let hours = hourly_buckets(&pieces, &eff, rule.max_moving_ms());
    // Harita çizgisi uzun atlamalarda ayrıca kesilir (bkz. GapRule::fixed).
    let (drawn, _) = segments::split_with(&pieces, &GapRule::fixed());
    let simplified: Vec<Vec<Point>> = drawn
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
    let all = primary_segments(gpx);
    // Boşluklar tüm kaydın kuralıyla belirlenir (grafikle aynı); dilimin kendi
    // nokta sıklığı başka sonuç verebiliyordu.
    let rule = GapRule::of(&all);
    let parts = ops::slice_segments(&all, start, end);
    let parts: Vec<&[Point]> = parts.iter().map(|s| s.as_slice()).collect();
    segments::track_stats_with(&parts, cfg, &rule)
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
