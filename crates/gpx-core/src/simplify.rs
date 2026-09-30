//! Harita ve grafik için nokta azaltma algoritmaları.

use crate::parse::Point;

/// Douglas–Peucker sadeleştirmesi. `tolerance_m` metre cinsindendir; noktalar
/// segmentin orta enlemine göre yerel düzleme (equirectangular) izdüşürülür.
/// Özyinelemesiz çalışır, çok uzun segmentlerde yığın taşması olmaz.
pub fn douglas_peucker(points: &[Point], tolerance_m: f64) -> Vec<Point> {
    let n = points.len();
    if n <= 2 {
        return points.to_vec();
    }
    let mid_lat = points[n / 2].lat.to_radians();
    let kx = 111_320.0 * mid_lat.cos();
    let ky = 110_574.0;
    let xy: Vec<(f64, f64)> = points.iter().map(|p| (p.lon * kx, p.lat * ky)).collect();
    let tol2 = tolerance_m * tolerance_m;

    let mut keep = vec![false; n];
    keep[0] = true;
    keep[n - 1] = true;
    let mut stack = vec![(0usize, n - 1)];
    while let Some((a, b)) = stack.pop() {
        if b <= a + 1 {
            continue;
        }
        let (ax, ay) = xy[a];
        let (bx, by) = xy[b];
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        let mut max_d2 = -1.0;
        let mut idx = a;
        for (i, &(px, py)) in xy.iter().enumerate().take(b).skip(a + 1) {
            let d2 = if len2 == 0.0 {
                (px - ax).powi(2) + (py - ay).powi(2)
            } else {
                let t = (((px - ax) * dx + (py - ay) * dy) / len2).clamp(0.0, 1.0);
                (px - ax - t * dx).powi(2) + (py - ay - t * dy).powi(2)
            };
            if d2 > max_d2 {
                max_d2 = d2;
                idx = i;
            }
        }
        if max_d2 > tol2 {
            keep[idx] = true;
            stack.push((a, idx));
            stack.push((idx, b));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter_map(|(p, k)| k.then_some(*p))
        .collect()
}

/// Largest-Triangle-Three-Buckets: grafiğin şeklini koruyarak `threshold`
/// sayıda örnek indeksi seçer. `x` artan sırada olmalıdır.
pub fn lttb_indices(x: &[f64], y: &[f64], threshold: usize) -> Vec<usize> {
    let n = x.len();
    if threshold >= n || threshold < 3 {
        return (0..n).collect();
    }
    let mut out = Vec::with_capacity(threshold);
    out.push(0);
    let bucket = (n - 2) as f64 / (threshold - 2) as f64;
    let mut a = 0usize;
    for i in 0..threshold - 2 {
        let next_start = ((i + 1) as f64 * bucket) as usize + 1;
        let next_end = (((i + 2) as f64 * bucket) as usize + 1).min(n);
        let (mut avg_x, mut avg_y) = (0.0, 0.0);
        let cnt = (next_end - next_start).max(1) as f64;
        for k in next_start..next_end {
            avg_x += x[k];
            avg_y += y[k];
        }
        avg_x /= cnt;
        avg_y /= cnt;

        let start = (i as f64 * bucket) as usize + 1;
        let end = (((i + 1) as f64 * bucket) as usize + 1).min(n);
        let (ax, ay) = (x[a], y[a]);
        let mut best = start;
        let mut best_area = -1.0;
        for k in start..end {
            let area = ((ax - avg_x) * (y[k] - ay) - (ax - x[k]) * (avg_y - ay)).abs();
            if area > best_area {
                best_area = area;
                best = k;
            }
        }
        out.push(best);
        a = best;
    }
    out.push(n - 1);
    out
}
