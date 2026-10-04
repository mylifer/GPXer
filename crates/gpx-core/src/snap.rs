//! Seyrek kayıtları yola oturtma (harita eşleştirme). Eşleştirme servisi
//! çağıran taraftan gelir (`matcher`); burada parçalara bölme, eşleşen yolun
//! kayda yerleştirilmesi ve yeni noktalara zaman/yükseklik verilmesi var.

use crate::parse::{Gpx, Point};
use crate::stats::haversine_m;

/// Servisin bir istekte kabul ettiği en çok nokta.
pub const MAX_CHUNK: usize = 100;

/// Bir parçanın eşleştirme sonucu (girişle aynı sırada).
#[derive(Debug, Default, Clone)]
pub struct Matched {
    /// Her noktanın yola oturtulmuş konumu `(enlem, boylam)`; eşleşmeyen `None`.
    pub snapped: Vec<Option<(f64, f64)>>,
    /// `legs[i]`: i. noktadan i+1. noktaya giden yol (iki ucu dahil); yol
    /// bulunamadıysa `None` (o arada düz çizgi kalır).
    pub legs: Vec<Option<Vec<(f64, f64)>>>,
}

/// Asıl segmentleri yola oturtur. `matcher` en çok [`MAX_CHUNK`] noktalık
/// parçalar alır (`(enlem, boylam, zaman)`). Eşleşen nokta sayısını döner.
pub fn snap_to_roads<E>(
    gpx: &mut Gpx,
    matcher: impl FnMut(&[(f64, f64, Option<i64>)]) -> Result<Matched, E>,
) -> Result<usize, E> {
    let mut matcher = matcher;
    let source = if gpx.tracks.is_empty() {
        &mut gpx.routes
    } else {
        &mut gpx.tracks
    };
    let mut matched = 0;
    for seg in source.iter_mut().flat_map(|t| t.segments.iter_mut()) {
        if seg.len() < 2 {
            continue;
        }
        let mut out: Vec<Point> = Vec::with_capacity(seg.len() * 4);
        let mut start = 0;
        // Parçalar bir nokta örtüşür: parça sınırındaki ara yol da eşleşsin.
        while start + 1 < seg.len() {
            let end = (start + MAX_CHUNK).min(seg.len());
            let chunk = &seg[start..end];
            let input: Vec<(f64, f64, Option<i64>)> =
                chunk.iter().map(|p| (p.lat, p.lon, p.time)).collect();
            let m = matcher(&input)?;
            for (k, p) in chunk.iter().enumerate() {
                // Önceki parçanın son noktası bu parçanın ilkidir.
                if k > 0 || start == 0 {
                    let mut q = *p;
                    if let Some(Some((la, lo))) = m.snapped.get(k) {
                        q.lat = *la;
                        q.lon = *lo;
                        matched += 1;
                    }
                    out.push(q);
                }
                let Some(next) = chunk.get(k + 1) else { break };
                if let Some(Some(path)) = m.legs.get(k) {
                    fill_leg(&mut out, p, next, path);
                }
            }
            start = end - 1;
        }
        *seg = out;
    }
    Ok(matched)
}

/// İki nokta arasındaki yolun iç noktalarını, zaman ve yüksekliği yol
/// boyunca mesafe oranında dağıtarak ekler.
fn fill_leg(out: &mut Vec<Point>, a: &Point, b: &Point, path: &[(f64, f64)]) {
    if path.len() < 3 {
        return;
    }
    let pts: Vec<Point> = path
        .iter()
        .map(|&(lat, lon)| Point {
            lat,
            lon,
            ..Default::default()
        })
        .collect();
    let mut cum = vec![0.0];
    for w in pts.windows(2) {
        cum.push(cum.last().unwrap() + haversine_m(&w[0], &w[1]));
    }
    let total = *cum.last().unwrap();
    for (i, mut p) in pts.into_iter().enumerate().take(path.len() - 1).skip(1) {
        let f = if total > 0.0 { cum[i] / total } else { 0.5 };
        p.time = match (a.time, b.time) {
            (Some(t0), Some(t1)) => Some(t0 + ((t1 - t0) as f64 * f).round() as i64),
            _ => None,
        };
        p.ele = match (a.ele, b.ele) {
            (Some(e0), Some(e1)) => Some(e0 + (e1 - e0) * f as f32),
            (e, None) | (None, e) => e,
        };
        out.push(p);
    }
}

/// Kayıt seyrek mi (yola oturtma anlamlı mı): noktalar arası ortanca mesafe.
pub fn median_step_m(gpx: &Gpx) -> Option<f64> {
    let mut d: Vec<f64> = gpx
        .tracks
        .iter()
        .chain(&gpx.routes)
        .flat_map(|t| t.segments.iter())
        .flat_map(|s| s.windows(2).map(|w| haversine_m(&w[0], &w[1])))
        .collect();
    if d.is_empty() {
        return None;
    }
    let mid = d.len() / 2;
    let (_, m, _) = d.select_nth_unstable_by(mid, f64::total_cmp);
    Some(*m)
}
