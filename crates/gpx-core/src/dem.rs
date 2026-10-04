//! Arazi yüksekliğiyle (sayısal yükseklik modeli) GPS yüksekliğini değiştirme.
//! Yükseklik servisi çağıran taraftan gelir (`lookup`); burada yalnızca hangi
//! noktaların sorulacağı ve aradakilerin nasıl doldurulacağı var.

use crate::parse::Gpx;
use crate::stats::haversine_m;

/// Sorulan noktalar arası en kısa mesafe (m); DEM çözünürlüğü (~90 m) bundan
/// ayrıntılı değil.
const MIN_SPACING_M: f64 = 60.0;
/// Bir kayıtta en çok bu kadar nokta sorulur (çok uzun kayıtlarda aralık açılır).
const MAX_SAMPLES: usize = 8000;

/// Asıl segmentlerdeki her noktanın yüksekliğini arazi yüksekliğiyle
/// değiştirir. Noktalar mesafeye göre seyreltilip `lookup`a sorulur (konum
/// listesi → aynı sırada yükseklikler), aradakiler mesafe oranında doldurulur.
/// Değiştirilen nokta sayısını döner.
pub fn apply_dem<E>(
    gpx: &mut Gpx,
    lookup: impl FnMut(&[(f64, f64)]) -> Result<Vec<Option<f64>>, E>,
) -> Result<usize, E> {
    let mut lookup = lookup;
    let source = if gpx.tracks.is_empty() {
        &mut gpx.routes
    } else {
        &mut gpx.tracks
    };
    let total_m: f64 = source
        .iter()
        .flat_map(|t| t.segments.iter())
        .map(|s| s.windows(2).map(|w| haversine_m(&w[0], &w[1])).sum::<f64>())
        .sum();
    let spacing = MIN_SPACING_M.max(total_m / MAX_SAMPLES as f64);
    let mut changed = 0;
    for seg in source.iter_mut().flat_map(|t| t.segments.iter_mut()) {
        if seg.is_empty() {
            continue;
        }
        // Kümülatif mesafe ve sorulacak noktalar (ilk, son ve her `spacing`).
        let mut cum = Vec::with_capacity(seg.len());
        let mut d = 0.0;
        let mut picks = vec![0usize];
        let mut last_pick = 0.0;
        for i in 0..seg.len() {
            if i > 0 {
                d += haversine_m(&seg[i - 1], &seg[i]);
            }
            cum.push(d);
            if i > 0 && d - last_pick >= spacing {
                picks.push(i);
                last_pick = d;
            }
        }
        if *picks.last().unwrap() != seg.len() - 1 {
            picks.push(seg.len() - 1);
        }
        let coords: Vec<(f64, f64)> = picks.iter().map(|&i| (seg[i].lat, seg[i].lon)).collect();
        let elev = lookup(&coords)?;
        // Yanıtı olmayan (denizde, veri dışı) noktalar atlanır.
        let known: Vec<(usize, f64)> = picks
            .iter()
            .zip(&elev)
            .filter_map(|(&i, e)| e.filter(|v| v.is_finite()).map(|v| (i, v)))
            .collect();
        if known.is_empty() {
            continue;
        }
        let mut k = 0;
        for i in 0..seg.len() {
            while k + 1 < known.len() && known[k + 1].0 <= i {
                k += 1;
            }
            let (i0, e0) = known[k];
            let e = if i <= i0 || k + 1 >= known.len() {
                e0
            } else {
                let (i1, e1) = known[k + 1];
                let span = cum[i1] - cum[i0];
                if span > 0.0 {
                    e0 + (e1 - e0) * (cum[i] - cum[i0]) / span
                } else {
                    e0
                }
            };
            seg[i].ele = Some(e as f32);
            changed += 1;
        }
    }
    Ok(changed)
}
