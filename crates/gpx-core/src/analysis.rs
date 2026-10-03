//! Kayıt çözümlemeleri: GPS sıçramalarını temizleme, duraklamaları bulma ve
//! etkinlik türünü tahmin etme.

use crate::parse::{Gpx, Point};
use crate::stats::{haversine_m, Stats, StatsConfig};
use serde::{Deserialize, Serialize};

/// Sıçrama: iz bu kadar uzağa çıkıp geri dönmeli ...
const SPIKE_MIN_DEV_M: f64 = 150.0;
/// ... ve gittiği uzaklık, çıktığı ve döndüğü noktalar arasındaki mesafenin
/// en az bu katı olmalı (düz giden hızlı hareket böylece sıçrama sayılmaz).
const SPIKE_DEV_RATIO: f64 = 2.0;
/// Bir sıçrama en fazla bu kadar nokta ve süre sürebilir.
const SPIKE_MAX_POINTS: usize = 12;
const SPIKE_MAX_MS: i64 = 10 * 60 * 1000;
/// Sıçramadaki hız, çevresindeki olağan hızın en az bu katı ve şu kadar olmalı.
const SPIKE_SPEED_FACTOR: f64 = 3.0;
const SPIKE_MIN_SPEED_MS: f64 = 4.0;
/// Segmentin başında/sonunda izin geri kalanından kopuk en fazla bu kadar nokta atılır.
const EDGE_POINTS: usize = 5;
/// Kopukluk: en az bu kadar uzak ve izin devamındaki hızın bu katından hızlı.
const EDGE_MIN_JUMP_M: f64 = 500.0;
const EDGE_SPEED_FACTOR: f64 = 5.0;
const EDGE_MIN_SPEED_MS: f64 = 30.0;
/// Duraklama: en az bu kadar süre ...
pub const STOP_MIN_MS: i64 = 2 * 60 * 1000;
/// ... bu yarıçap içinde kalınması.
pub const STOP_RADIUS_M: f64 = 40.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Activity {
    Walk,
    Run,
    Bike,
    Car,
    #[default]
    Unknown,
}

impl Activity {
    pub fn parse(s: &str) -> Option<Activity> {
        Some(match s {
            "walk" => Activity::Walk,
            "run" => Activity::Run,
            "bike" => Activity::Bike,
            "car" => Activity::Car,
            "unknown" => Activity::Unknown,
            _ => return None,
        })
    }

    /// Türün kendi hesaplama eşikleri (Ayarlar → "türe göre eşikler").
    pub fn thresholds(self, base: &StatsConfig) -> StatsConfig {
        let (kmh, ele) = match self {
            Activity::Walk => (1.0, 5.0),
            Activity::Run => (2.5, 3.0),
            Activity::Bike => (3.5, 3.0),
            Activity::Car => (6.0, 5.0),
            Activity::Unknown => return *base,
        };
        StatsConfig {
            moving_speed_ms: kmh / 3.6,
            elevation_threshold_m: ele,
            ..*base
        }
    }
}

/// Hız (ve varsa kadans) ile etkinlik türü tahmini.
pub fn classify(s: &Stats) -> Activity {
    let Some(avg) = s.avg_moving_speed_ms.map(|v| v * 3.6) else {
        return Activity::Unknown;
    };
    let max = s.max_speed_ms.map_or(0.0, |v| v * 3.6);
    // Koşuda adım kadansı ~150–190; bisiklette pedal kadansı ~60–100.
    let running_cadence = s.avg_cad.is_some_and(|c| c > 130.0);
    if avg >= 40.0 || max >= 90.0 {
        Activity::Car
    } else if avg < 7.0 {
        Activity::Walk
    } else if running_cadence || (avg < 13.0 && max < 28.0) || (avg < 16.0 && max < 25.0) {
        Activity::Run
    } else {
        Activity::Bike
    }
}

fn median(mut v: Vec<f64>) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    Some(v[v.len() / 2])
}

/// İki nokta arasındaki hız (m/s); zaman yoksa `None`. Sıra önemli değildir.
/// Saniyenin altındaki aralıklar 1 sn sayılır (yuvarlanmış zaman damgaları).
fn step_speed(a: &Point, b: &Point) -> Option<f64> {
    let dt = (b.time? - a.time?).abs();
    Some(haversine_m(a, b) / (dt.max(1000) as f64 / 1000.0))
}

/// Verilen noktalar arasındaki adımların ortanca hızı.
fn median_speed<'a>(pts: impl Iterator<Item = &'a Point>) -> Option<f64> {
    let pts: Vec<&Point> = pts.collect();
    median(
        pts.windows(2)
            .filter_map(|w| step_speed(w[0], w[1]))
            .collect(),
    )
}

/// `a`dan çıkıp `run` noktalarından geçerek `b`ye dönen bölüm bir sıçrama mı?
/// `local_speed` çevredeki olağan hızı verir; yalnızca şekil uyuyorsa
/// hesaplanır (pahalı).
fn is_excursion(
    a: &Point,
    run: &[Point],
    b: &Point,
    local_speed: impl FnOnce() -> Option<f64>,
) -> bool {
    let d_ab = haversine_m(a, b);
    // Her noktanın iki uca da uzaklığı; sıçramadaki her nokta uzakta olmalı,
    // yoksa sıçramanın öncesindeki/sonrasındaki doğru noktalar da atılırdı.
    let far: Vec<f64> = run
        .iter()
        .map(|p| haversine_m(a, p).min(haversine_m(p, b)))
        .collect();
    let dev = far.iter().copied().fold(0.0, f64::max);
    let near = far.iter().copied().fold(f64::INFINITY, f64::min);
    if dev < SPIKE_MIN_DEV_M
        || dev < SPIKE_DEV_RATIO * d_ab
        || near < (dev * 0.3).max(SPIKE_DEV_RATIO * d_ab)
    {
        return false;
    }
    match (a.time, b.time) {
        (Some(ta), Some(tb)) if tb >= ta => {
            let mut path = 0.0;
            let mut prev = a;
            for p in run.iter().chain(std::iter::once(b)) {
                path += haversine_m(prev, p);
                prev = p;
            }
            let speed = path / ((tb - ta).max(1000) as f64 / 1000.0);
            let usual = local_speed().unwrap_or(0.0);
            speed > (usual * SPIKE_SPEED_FACTOR).max(SPIKE_MIN_SPEED_MS)
        }
        // Zaman yoksa yalnızca belirgin ve kısa dikenler.
        _ => run.len() <= 3 && dev > 300.0 && dev > 3.0 * d_ab,
    }
}

/// `a`dan `b`ye adım, izin devamına göre kopuk mu?
fn is_detached(a: &Point, b: &Point, rest: &[Point]) -> bool {
    let d = haversine_m(a, b);
    if d < EDGE_MIN_JUMP_M {
        return false;
    }
    let usual = median_speed(rest.iter().take(11)).unwrap_or(0.0);
    match step_speed(a, b) {
        Some(v) => v > (usual * EDGE_SPEED_FACTOR).max(EDGE_MIN_SPEED_MS),
        None => {
            let steps: Vec<f64> = rest
                .windows(2)
                .take(10)
                .map(|w| haversine_m(&w[0], &w[1]))
                .collect();
            d > 2000.0 && median(steps).is_some_and(|m| d > 20.0 * m)
        }
    }
}

/// Tek bir segmentteki sıçramaları ayıklar; atılan nokta sayısını döndürür.
///
/// - İzden bir ya da birkaç noktalığına uzağa çıkıp aynı yere dönen,
///   bunu çevresindeki olağan hızın çok üstünde yapan noktalar atılır. Düz
///   giden hızlı hareket (uçak, tren) ve gerçek yer değiştirmeler korunur.
/// - Segmentin başında ya da sonunda izin geri kalanından kopuk birkaç nokta
///   (uydu kilitlenmeden alınmış ya da eski konum) atılır.
pub fn clean_segment(seg: &mut Vec<Point>) -> usize {
    let mut idx = (0..seg.len() as u32).collect();
    clean_segment_indexed(seg, &mut idx)
}

/// [`clean_segment`]; `idx` noktalarla birlikte süzülür (her kalan noktanın
/// ham kayıttaki sırası).
pub fn clean_segment_indexed(seg: &mut Vec<Point>, idx: &mut Vec<u32>) -> usize {
    debug_assert_eq!(seg.len(), idx.len());
    let before = seg.len();
    remove_excursions(seg, idx);
    trim_detached_edges(seg, idx);
    before - seg.len()
}

/// Sıçramadaki her nokta, çıktığı noktadan en az bu kadar uzakta olmalıdır
/// (`is_excursion`daki `near` koşulunun alt sınırı). Ucuz ön eleme için.
const SPIKE_MIN_NEAR_M: f64 = SPIKE_MIN_DEV_M * 0.3;

/// Hızlı yaklaşık uzaklık (eşdikdörtgen izdüşüm, `cos_lat` = cos(a.lat));
/// 50 km'ye kadar hatası %1'in altında, ötesinde tam hesaplanır. Yalnızca
/// paylı ön elemede kullanılır.
fn quick_m(a: &Point, b: &Point, cos_lat: f64) -> f64 {
    const R: f64 = 6_371_008.8;
    let dlat = (b.lat - a.lat).to_radians();
    let mut dlon = b.lon - a.lon;
    if dlon > 180.0 {
        dlon -= 360.0;
    } else if dlon < -180.0 {
        dlon += 360.0;
    }
    let x = dlon.to_radians() * cos_lat;
    let d = R * (dlat * dlat + x * x).sqrt();
    if d > 50_000.0 {
        haversine_m(a, b)
    } else {
        d
    }
}

/// İzden çıkıp aynı yere dönen sıçramaları atar.
fn remove_excursions(seg: &mut Vec<Point>, idx: &mut Vec<u32>) {
    if seg.len() < 3 {
        return;
    }
    let pts = std::mem::take(seg);
    let ids = std::mem::take(idx);
    let mut out: Vec<Point> = Vec::with_capacity(pts.len());
    let mut out_ids: Vec<u32> = Vec::with_capacity(pts.len());
    let mut i = 0;
    while i < pts.len() {
        let Some(a) = out.last().copied() else {
            out.push(pts[i]);
            out_ids.push(ids[i]);
            i += 1;
            continue;
        };
        // Çevredeki olağan hız: önceki 10 nokta ve olası sıçramanın
        // ötesindeki 10 nokta. Gerekirse bir kez hesaplanır.
        let after = (i + SPIKE_MAX_POINTS).min(pts.len());
        let mut local: Option<Option<f64>> = None;
        let mut local_speed = || {
            *local.get_or_insert_with(|| {
                median_speed(
                    out[out.len().saturating_sub(10)..]
                        .iter()
                        .chain(pts[after..].iter().take(10)),
                )
            })
        };
        // Bu noktadan başlayan en kısa sıçrama. Önce yaklaşık uzaklıklarla
        // (paylı) ucuz ön eleme yapılır; sık kayıtlarda neredeyse her nokta
        // burada elenir.
        let cos_a = a.lat.to_radians().cos();
        let (mut min_a, mut max_a) = (f64::INFINITY, 0.0_f64);
        let mut spike = None;
        for k in 1..=SPIKE_MAX_POINTS {
            if i + k >= pts.len() {
                break;
            }
            // Sıçramadaki her nokta çıkış noktasından uzak olmalı; yakın bir
            // noktaya gelince daha uzun sıçrama da olamaz.
            let q = quick_m(&a, &pts[i + k - 1], cos_a);
            if q < SPIKE_MIN_NEAR_M * 0.9 {
                break;
            }
            min_a = min_a.min(q);
            max_a = max_a.max(q);
            let b = &pts[i + k];
            if let (Some(ta), Some(tb)) = (a.time, b.time) {
                if tb - ta > SPIKE_MAX_MS {
                    break;
                }
            }
            // Sıçrama yeterince uzağa çıkmalı ve dönüş noktası çıkış noktasına,
            // sıçramadaki noktaların yarı uzaklığından yakın olmalı.
            if max_a < SPIKE_MIN_DEV_M * 0.9 || quick_m(&a, b, cos_a) > 0.6 * min_a {
                continue;
            }
            if is_excursion(&a, &pts[i..i + k], b, &mut local_speed) {
                spike = Some(k);
                break;
            }
        }
        match spike {
            Some(k) => i += k,
            None => {
                out.push(pts[i]);
                out_ids.push(ids[i]);
                i += 1;
            }
        }
    }
    *seg = out;
    *idx = out_ids;
}

/// Segmentin başında ve sonunda izin geri kalanından kopuk birkaç noktayı atar.
fn trim_detached_edges(seg: &mut Vec<Point>, idx: &mut Vec<u32>) {
    let n = seg.len();
    if n < 3 {
        return;
    }
    // Baştaki k nokta: k. noktaya kopuk bir sıçramayla geçiliyor ve ilk nokta
    // da izin devamından uzakta (geri dönen sıçrama başka kural).
    // En kısa kopuk baş seçilir; böylece kopukluktan sonraki doğru noktalar kalır.
    let head = (1..=EDGE_POINTS.min(n - 2))
        .find(|&k| {
            is_detached(&seg[k - 1], &seg[k], &seg[k..])
                && haversine_m(&seg[0], &seg[k]) > EDGE_MIN_JUMP_M
        })
        .unwrap_or(0);
    let tail = (1..=EDGE_POINTS.min(n.saturating_sub(head + 2)))
        .find(|&k| {
            let i = n - k;
            // `is_detached` yalnızca ilk 11 noktaya bakar.
            let rest: Vec<Point> = seg[head..i].iter().rev().take(11).copied().collect();
            is_detached(&seg[i], &seg[i - 1], &rest)
                && haversine_m(&seg[n - 1], &seg[i - 1]) > EDGE_MIN_JUMP_M
        })
        .unwrap_or(0);
    seg.truncate(n - tail);
    seg.drain(..head);
    idx.truncate(n - tail);
    idx.drain(..head);
}

/// Kaydın asıl segmentleri (iz varsa izler, yoksa rotalar).
fn primary_mut(gpx: &mut Gpx) -> impl Iterator<Item = &mut Vec<Point>> {
    let source = if gpx.tracks.is_empty() {
        &mut gpx.routes
    } else {
        &mut gpx.tracks
    };
    source.iter_mut().flat_map(|t| t.segments.iter_mut())
}

/// Kaydın asıl segmentlerindeki sıçramaları temizler.
pub fn clean_spikes(gpx: &mut Gpx) -> usize {
    primary_mut(gpx).map(clean_segment).sum()
}

/// Uçakla bile ulaşılamayacak hız: bundan hızlı sıçrama GPS hatasıdır.
const TELEPORT_MS: f64 = 1200.0 / 3.6;
/// Sıçramanın en az bu kadar uzağa olması gerekir ...
const TELEPORT_MIN_M: f64 = 100_000.0;
/// ... ve yanlış yerde en fazla bu kadar segment / süre kalınmış olmalı.
const TELEPORT_MAX_SEGMENTS: usize = 6;
const TELEPORT_MAX_MS: i64 = 24 * 3_600_000;

/// Bütünüyle yanlış yerde kalan segment dizileri: önceki noktadan uçakla
/// bile ulaşılamayan bir yere gidip, oradan yine öyle bir sıçramayla
/// başlangıca dönen segmentler (ör. telefonun saatlerce Boston'da ya da
/// okyanusta görünmesi). Segment içi temizlik bunları göremez. Atılacak
/// segmentlerin sırası döner.
pub fn teleport_segments(segs: &[&[Point]]) -> Vec<usize> {
    let jump = |a: &Point, b: &Point| -> Option<f64> {
        let dt = (b.time? - a.time?).abs().max(1000) as f64 / 1000.0;
        let d = haversine_m(a, b);
        (d > TELEPORT_MIN_M && d / dt > TELEPORT_MS).then_some(d)
    };
    let non_empty: Vec<usize> = (0..segs.len()).filter(|&i| !segs[i].is_empty()).collect();
    let mut out = Vec::new();
    let mut k = 1;
    while k + 1 < non_empty.len() {
        let prev = *segs[non_empty[k - 1]].last().unwrap();
        let first = &segs[non_empty[k]][0];
        let Some(d_in) = jump(&prev, first) else {
            k += 1;
            continue;
        };
        let mut found = None;
        for e in k..(k + TELEPORT_MAX_SEGMENTS).min(non_empty.len() - 1) {
            let last = segs[non_empty[e]].last().unwrap();
            if last
                .time
                .zip(first.time)
                .is_some_and(|(b, a)| b - a > TELEPORT_MAX_MS)
            {
                break;
            }
            let next = &segs[non_empty[e + 1]][0];
            // Dönüş: oradan yine ulaşılamaz hızla, başlangıca yakın bir yere.
            if jump(last, next).is_some() && haversine_m(&prev, next) < 0.2 * d_in {
                found = Some(e);
                break;
            }
        }
        match found {
            Some(e) => {
                out.extend(non_empty[k..=e].iter().copied());
                k = e + 2;
            }
            None => k += 1,
        }
    }
    out
}

/// Duraklama sayılması için en az bu kadar süre ...
const STAY_MIN_MS: i64 = 10 * 60 * 1000;
/// ... bu yarıçap içinde kalınmalı.
const STAY_RADIUS_M: f64 = 120.0;
/// Duraklama sırasında yarıçapın dışına en fazla bu kadar nokta/süre çıkılıp
/// dönülebilir (titreme ya da kısa sıçrama); daha uzunsa duraklama biter.
const STAY_MAX_OUT_POINTS: usize = 8;
const STAY_MAX_OUT_MS: i64 = 5 * 60 * 1000;

/// Titreme sınaması: noktadan en az bu kadar sonraki noktaya bakılır ...
const JITTER_SPAN_MS: i64 = 30_000;
/// ... (en az bu kadar adım ötesine) ...
const JITTER_SPAN_STEPS: usize = 3;
/// ... ve aradaki yolun en az bu oranı kadar ilerlenmişse hareket vardır.
/// Gerçek harekette (pist turu bile) iz düzgün ilerler; titremede noktalar
/// merkez çevresinde rastgele dağıldığından kuş uçuşu ilerleme yolun küçük
/// bir kısmıdır.
const JITTER_MAX_PROGRESS: f64 = 0.5;
/// Aralıktaki yolun ortalama hızı bunun altındaysa ilerleme ne olursa olsun
/// duraklamadır (seyrek kayıt ya da yavaş kayan konum).
const JITTER_MAX_SPEED_MS: f64 = 0.5;

/// Noktalar gerçek bir hareket değil, yerinde durulurken konum titremesi mi?
fn is_jitter(pts: &[Point]) -> bool {
    // Kümülatif yol.
    let mut cum = Vec::with_capacity(pts.len());
    let mut d = 0.0;
    for (k, p) in pts.iter().enumerate() {
        if k > 0 {
            d += haversine_m(&pts[k - 1], p);
        }
        cum.push(d);
    }
    let times = pts.iter().filter_map(|p| p.time);
    if let (Some(a), Some(b)) = (times.clone().min(), times.max()) {
        if b > a && d / ((b - a) as f64 / 1000.0) < JITTER_MAX_SPEED_MS {
            return true;
        }
    }
    let mut ratios = Vec::new();
    let mut j = 0;
    for k in 0..pts.len() {
        let Some(tk) = pts[k].time else { continue };
        j = j.max(k + JITTER_SPAN_STEPS);
        while j < pts.len() && pts[j].time.is_none_or(|t| t - tk < JITTER_SPAN_MS) {
            j += 1;
        }
        if j >= pts.len() {
            break;
        }
        let path = cum[j] - cum[k];
        if path > 0.0 {
            ratios.push(haversine_m(&pts[k], &pts[j]) / path);
        }
    }
    // Ölçülemiyorsa (çok az nokta) eski davranış: duraklama.
    median(ratios).is_none_or(|r| r < JITTER_MAX_PROGRESS)
}

/// Uzun duraklamaları tek noktaya indirir: bir yerde uzun süre kalınırken GPS
/// konumu onlarca, yüzlerce metre titrer ve iz yumak gibi görünür. Bu
/// aralıktaki noktalar duraklamanın merkezinde, başlangıç ve bitiş zamanlı iki
/// noktaya dönüşür. Küçük bir alanda gerçek hareket (pistte koşu) korunur.
/// Atılan nokta sayısını döndürür.
pub fn collapse_stays(gpx: &mut Gpx) -> usize {
    primary_mut(gpx).map(collapse_segment_stays).sum()
}

/// Tek segmentteki uzun duraklamaları tek noktaya indirir.
pub fn collapse_segment_stays(seg: &mut Vec<Point>) -> usize {
    let mut idx = (0..seg.len() as u32).collect();
    collapse_segment_stays_indexed(seg, &mut idx)
}

/// [`collapse_segment_stays`]; `idx` noktalarla birlikte güncellenir
/// (duraklamanın iki noktası ilk ve son noktanın sırasını alır).
pub fn collapse_segment_stays_indexed(seg: &mut Vec<Point>, idx: &mut Vec<u32>) -> usize {
    debug_assert_eq!(seg.len(), idx.len());
    let n = seg.len();
    if n < 3 || seg.iter().all(|p| p.time.is_none()) {
        return 0;
    }
    let pts = std::mem::take(seg);
    let ids = std::mem::take(idx);
    let mut out: Vec<Point> = Vec::with_capacity(n);
    let mut out_ids: Vec<u32> = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        let Some(t0) = pts[i].time else {
            out.push(pts[i]);
            out_ids.push(ids[i]);
            i += 1;
            continue;
        };
        // Yarıçap içindeki noktaların ortalaması merkezdir; dışarı çıkıp kısa
        // sürede dönen noktalar duraklamaya dahildir ama merkezi etkilemez.
        let (mut sum_lat, mut sum_lon, mut count) = (pts[i].lat, pts[i].lon, 1.0);
        let mut last_in = i;
        let mut j = i + 1;
        while j < n {
            let center = Point {
                lat: sum_lat / count,
                lon: sum_lon / count,
                ..Point::default()
            };
            if haversine_m(&center, &pts[j]) <= STAY_RADIUS_M {
                sum_lat += pts[j].lat;
                sum_lon += pts[j].lon;
                count += 1.0;
                last_in = j;
            } else {
                let out_ms = match (pts[last_in].time, pts[j].time) {
                    (Some(a), Some(b)) => b - a,
                    _ => 0,
                };
                if j - last_in > STAY_MAX_OUT_POINTS || out_ms > STAY_MAX_OUT_MS {
                    break;
                }
            }
            j += 1;
        }
        let t1 = pts[last_in].time.unwrap_or(t0);
        let long = last_in > i + 1 && t1 - t0 >= STAY_MIN_MS;
        if long && !is_jitter(&pts[i..=last_in]) {
            // Küçük alanda gerçek hareket: noktalar korunur. Sonraki pencereler
            // çoğunlukla aynı hareketi kapsar; her noktadan yeniden denemek
            // yerine pencerenin onda biri kadar ilerlenir.
            let step = ((last_in - i) / 10).max(1);
            out.extend_from_slice(&pts[i..i + step]);
            out_ids.extend_from_slice(&ids[i..i + step]);
            i += step;
            continue;
        }
        if long {
            let (lat, lon) = (sum_lat / count, sum_lon / count);
            out.push(Point { lat, lon, ..pts[i] });
            out.push(Point {
                lat,
                lon,
                ..pts[last_in]
            });
            out_ids.push(ids[i]);
            out_ids.push(ids[last_in]);
            i = last_in + 1;
        } else {
            out.push(pts[i]);
            out_ids.push(ids[i]);
            i += 1;
        }
    }
    let removed = n - out.len();
    *seg = out;
    *idx = out_ids;
    removed
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stop {
    pub lat: f64,
    pub lon: f64,
    /// Duraklamanın başladığı an (Unix ms).
    pub start: i64,
    pub duration_ms: i64,
}

/// Zaman bilgili segmentlerde en az [`STOP_MIN_MS`] boyunca [`STOP_RADIUS_M`]
/// yarıçapında kalınan yerleri bulur. Cihazın kapalı kaldığı (iki nokta arası
/// uzun boşluk) ama yer değiştirmediği anlar da duraklama sayılır.
pub fn detect_stops<'a>(segments: impl IntoIterator<Item = &'a [Point]>) -> Vec<Stop> {
    let mut stops = Vec::new();
    for seg in segments {
        let mut i = 0;
        while i < seg.len() {
            let Some(t0) = seg[i].time else {
                i += 1;
                continue;
            };
            let anchor = seg[i];
            let mut j = i;
            // Kümedeki en son zaman (zamansız noktalar süreyi kısaltmasın).
            let mut t1 = t0;
            while j + 1 < seg.len() && haversine_m(&anchor, &seg[j + 1]) <= STOP_RADIUS_M {
                j += 1;
                t1 = seg[j].time.map_or(t1, |t| t.max(t1));
            }
            if j > i && t1 - t0 >= STOP_MIN_MS {
                let n = (j - i + 1) as f64;
                let (lat, lon) = seg[i..=j]
                    .iter()
                    .fold((0.0, 0.0), |(a, b), p| (a + p.lat, b + p.lon));
                stops.push(Stop {
                    lat: lat / n,
                    lon: lon / n,
                    start: t0,
                    duration_ms: t1 - t0,
                });
                i = j + 1;
            } else {
                // Aynı (ya da geriye giden) zamanlı noktalardan başlayan
                // kümeler de kısa kalır; her birinden yeniden taramak
                // yerine zamanı ilerleyen ilk noktaya geçilir.
                i += 1;
                while i <= j && seg[i].time.is_none_or(|t| t <= t0) {
                    i += 1;
                }
            }
        }
    }
    stops
}
