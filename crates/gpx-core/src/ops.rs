//! GPX düzenleme işlemleri: kırpma, bölme, birleştirme.
//!
//! Nokta sıra numaraları, dosyanın asıl segmentleri (iz varsa izler, yoksa
//! rotalar) uç uca eklenmiş gibi sayılır; [`crate::Detail::idx`] ile aynıdır.

use crate::parse::{Gpx, Point, Track, Waypoint};
use crate::{haversine_m, primary_segments};

/// Segmentlerin `[start, end]` (dahil) aralığına düşen kısımları. Segment
/// sınırları korunur.
pub fn slice_segments(segments: &[&[Point]], start: usize, end: usize) -> Vec<Vec<Point>> {
    let mut out = Vec::new();
    let mut offset = 0;
    for seg in segments {
        let (a, b) = (offset, offset + seg.len());
        offset = b;
        let lo = start.max(a);
        let hi = (end + 1).min(b);
        if lo < hi {
            out.push(seg[lo - a..hi - a].to_vec());
        }
    }
    out
}

/// İşaret noktasının en yakın olduğu asıl noktanın sıra numarası.
fn nearest_index(segments: &[&[Point]], w: &Waypoint) -> Option<usize> {
    segments
        .iter()
        .flat_map(|s| s.iter())
        .enumerate()
        .map(|(i, p)| (i, haversine_m(p, &w.point)))
        .min_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
}

fn track_name(gpx: &Gpx) -> Option<String> {
    gpx.tracks
        .iter()
        .chain(&gpx.routes)
        .find_map(|t| t.name.clone())
        .or_else(|| gpx.name.clone())
}

fn part(gpx: &Gpx, start: usize, end: usize, name: Option<String>) -> Gpx {
    let segments = primary_segments(gpx);
    let waypoints = gpx
        .waypoints
        .iter()
        .filter(|w| nearest_index(&segments, w).is_none_or(|i| i >= start && i <= end))
        .cloned()
        .collect();
    let parts = slice_segments(&segments, start, end);
    let time = parts.iter().flatten().find_map(|p| p.time);
    Gpx {
        name: name.clone(),
        time,
        tracks: vec![Track {
            name,
            segments: parts,
        }],
        routes: Vec::new(),
        waypoints,
    }
}

fn point_count(gpx: &Gpx) -> usize {
    primary_segments(gpx).iter().map(|s| s.len()).sum()
}

/// `[start, end]` aralığını yeni bir kayıt olarak döndürür.
pub fn trim(gpx: &Gpx, start: usize, end: usize) -> Option<Gpx> {
    let n = point_count(gpx);
    if n == 0 || start > end || start >= n {
        return None;
    }
    let base = track_name(gpx).unwrap_or_else(|| "İz".into());
    Some(part(
        gpx,
        start,
        end.min(n - 1),
        Some(format!("{base} (kırpılmış)")),
    ))
}

/// `at` noktasından ikiye böler; nokta iki parçada da bulunur ki aralarında
/// boşluk kalmasın.
pub fn split(gpx: &Gpx, at: usize) -> Option<(Gpx, Gpx)> {
    let n = point_count(gpx);
    if n < 3 || at == 0 || at >= n - 1 {
        return None;
    }
    let base = track_name(gpx).unwrap_or_else(|| "İz".into());
    Some((
        part(gpx, 0, at, Some(format!("{base} (1. kısım)"))),
        part(gpx, at, n - 1, Some(format!("{base} (2. kısım)"))),
    ))
}

/// Kayıtları başlangıç zamanına göre sıralayıp tek dosyada birleştirir; her
/// kayıt ayrı bir iz (trk) olur.
pub fn merge(parts: Vec<Gpx>, name: Option<String>) -> Gpx {
    let mut parts = parts;
    let start = |g: &Gpx| {
        primary_segments(g)
            .iter()
            .flat_map(|s| s.iter())
            .find_map(|p| p.time)
            .or(g.time)
    };
    parts.sort_by_key(|g| start(g).unwrap_or(i64::MAX));
    let time = parts.iter().filter_map(start).min();
    let mut out = Gpx {
        name,
        time,
        ..Gpx::default()
    };
    for g in parts {
        let tname = track_name(&g);
        let segments: Vec<Vec<Point>> = primary_segments(&g).iter().map(|s| s.to_vec()).collect();
        if !segments.is_empty() {
            out.tracks.push(Track {
                name: tname,
                segments,
            });
        }
        out.waypoints.extend(g.waypoints);
    }
    out
}
