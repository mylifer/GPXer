//! Seçili dosyanın tam çözünürlüklü grafik verisi ([`Detail`]).

use crate::parse::{Gpx, Point};
use crate::stats::haversine_m;
use crate::{primary_segments, simplify, Detail, PROFILE_MAX_POINTS};

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

/// `gpx` [`prepare`](crate::prepare) edilmiş olmalıdır. Kayıt boşluklarında mesafe artmaz ve
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

    let rule = crate::GapRule::of(&segments);
    for seg in &segments {
        let base = all.len();
        let mut piece_start = base;
        for (i, p) in seg.iter().enumerate() {
            if i > 0 {
                if rule.is_gap(&seg[i - 1], p) {
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
