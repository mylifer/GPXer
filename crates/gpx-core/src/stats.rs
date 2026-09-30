//! Mesafe, süre, hız ve yükseklik istatistikleri.

use crate::parse::Point;
use serde::{Deserialize, Serialize};

const EARTH_RADIUS_M: f64 = 6_371_008.8;
/// İki nokta arası bu süreden uzunsa (ör. cihaz kapatılmış) hareket süresine eklenmez.
const MAX_MOVING_GAP_MS: i64 = 10 * 60 * 1000;
/// Maksimum hız GPS gürültüsünden etkilenmesin diye en az bu kadar sürelik
/// pencereler üzerinden hesaplanır.
const MAX_SPEED_WINDOW_MS: i64 = 10_000;

/// Kullanıcının ayarlayabildiği hesaplama eşikleri.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatsConfig {
    /// Bu hızın altındaki aralıklar "duruyor" sayılır (m/s).
    pub moving_speed_ms: f64,
    /// Yükseklik gürültüsünü bastırmak için eşik (metre).
    pub elevation_threshold_m: f64,
}

impl Default for StatsConfig {
    fn default() -> Self {
        // 0,5 m/s ≈ 1,8 km/sa
        Self {
            moving_speed_ms: 0.5,
            elevation_threshold_m: 3.0,
        }
    }
}

pub fn haversine_m(a: &Point, b: &Point) -> f64 {
    let (lat1, lat2) = (a.lat.to_radians(), b.lat.to_radians());
    let dlat = lat2 - lat1;
    let dlon = (b.lon - a.lon).to_radians();
    let h = (dlat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (dlon / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_M * h.sqrt().min(1.0).asin()
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Stats {
    pub point_count: usize,
    pub segment_count: usize,
    pub distance_m: f64,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    /// Başlangıç ile bitiş arasındaki toplam süre (ms).
    pub duration_ms: Option<i64>,
    /// Hareket halinde geçen süre (ms).
    pub moving_ms: Option<i64>,
    /// Hareket süresine göre ortalama hız (m/s).
    pub avg_moving_speed_ms: Option<f64>,
    pub max_speed_ms: Option<f64>,
    pub elevation_gain_m: Option<f64>,
    pub elevation_loss_m: Option<f64>,
    pub min_ele_m: Option<f64>,
    pub max_ele_m: Option<f64>,
    /// [minLon, minLat, maxLon, maxLat]
    pub bbox: Option<[f64; 4]>,
    pub avg_hr: Option<f64>,
    pub max_hr: Option<f64>,
    pub avg_cad: Option<f64>,
    pub avg_power: Option<f64>,
    pub max_power: Option<f64>,
    pub avg_temp: Option<f64>,
}

/// Örnek ortalaması ve en büyük değer için basit toplayıcı.
#[derive(Default)]
struct Acc {
    sum: f64,
    n: u32,
    max: Option<f64>,
}

impl Acc {
    fn add(&mut self, v: Option<f32>) {
        if let Some(v) = v {
            let v = v as f64;
            self.sum += v;
            self.n += 1;
            self.max = Some(self.max.map_or(v, |m| m.max(v)));
        }
    }
    fn avg(&self) -> Option<f64> {
        (self.n > 0).then(|| self.sum / self.n as f64)
    }
}

/// Birden çok segment üzerinden istatistik hesaplar. Segmentler arası
/// boşluklar (cihaz kapalıyken) mesafeye ve hareket süresine eklenmez.
pub fn compute_stats<'a>(
    segments: impl IntoIterator<Item = &'a [Point]>,
    cfg: &StatsConfig,
) -> Stats {
    let mut s = Stats::default();
    let (mut hr, mut cad, mut power, mut temp) = (
        Acc::default(),
        Acc::default(),
        Acc::default(),
        Acc::default(),
    );
    let mut moving_ms: i64 = 0;
    let mut has_time_pairs = false;
    let mut max_speed: Option<f64> = None;
    let mut gain = 0.0;
    let mut loss = 0.0;
    let mut has_ele = false;
    let mut bbox = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];

    for seg in segments {
        if seg.is_empty() {
            continue;
        }
        s.segment_count += 1;
        s.point_count += seg.len();

        let mut cum = Vec::with_capacity(seg.len());
        let mut d = 0.0;
        let mut ele_ref: Option<f64> = None;

        for (i, p) in seg.iter().enumerate() {
            bbox[0] = bbox[0].min(p.lon);
            bbox[1] = bbox[1].min(p.lat);
            bbox[2] = bbox[2].max(p.lon);
            bbox[3] = bbox[3].max(p.lat);
            hr.add(p.hr);
            cad.add(p.cad);
            power.add(p.power);
            temp.add(p.temp);

            if let Some(t) = p.time {
                s.start_time = Some(s.start_time.map_or(t, |v: i64| v.min(t)));
                s.end_time = Some(s.end_time.map_or(t, |v: i64| v.max(t)));
            }

            if let Some(e) = p.ele {
                let e = e as f64;
                has_ele = true;
                s.min_ele_m = Some(s.min_ele_m.map_or(e, |v: f64| v.min(e)));
                s.max_ele_m = Some(s.max_ele_m.map_or(e, |v: f64| v.max(e)));
                match ele_ref {
                    None => ele_ref = Some(e),
                    Some(r) => {
                        let diff = e - r;
                        if diff >= cfg.elevation_threshold_m {
                            gain += diff;
                            ele_ref = Some(e);
                        } else if diff <= -cfg.elevation_threshold_m {
                            loss -= diff;
                            ele_ref = Some(e);
                        }
                    }
                }
            }

            if i > 0 {
                let prev = &seg[i - 1];
                let step = haversine_m(prev, p);
                d += step;
                if let (Some(t0), Some(t1)) = (prev.time, p.time) {
                    let dt = t1 - t0;
                    if dt > 0 {
                        has_time_pairs = true;
                        let speed = step / (dt as f64 / 1000.0);
                        if speed >= cfg.moving_speed_ms && dt <= MAX_MOVING_GAP_MS {
                            moving_ms += dt;
                        }
                    }
                }
            }
            cum.push(d);
        }
        s.distance_m += d;

        // Kayan pencereyle maksimum hız.
        let mut j = 0;
        for i in 0..seg.len() {
            let Some(ti) = seg[i].time else { continue };
            if j < i {
                j = i;
            }
            while j < seg.len() {
                match seg[j].time {
                    Some(tj) if tj - ti >= MAX_SPEED_WINDOW_MS => break,
                    _ => j += 1,
                }
            }
            if j >= seg.len() {
                break;
            }
            let dt = (seg[j].time.unwrap() - ti) as f64 / 1000.0;
            if dt > 0.0 && dt * 1000.0 <= MAX_MOVING_GAP_MS as f64 {
                let v = (cum[j] - cum[i]) / dt;
                max_speed = Some(max_speed.map_or(v, |m: f64| m.max(v)));
            }
        }
    }

    if let (Some(a), Some(b)) = (s.start_time, s.end_time) {
        s.duration_ms = Some(b - a);
    }
    if has_time_pairs {
        s.moving_ms = Some(moving_ms);
        if moving_ms > 0 {
            s.avg_moving_speed_ms = Some(s.distance_m / (moving_ms as f64 / 1000.0));
        }
        s.max_speed_ms = max_speed;
    }
    if has_ele {
        s.elevation_gain_m = Some(gain);
        s.elevation_loss_m = Some(loss);
    }
    if s.point_count > 0 {
        s.bbox = Some(bbox);
    }
    s.avg_hr = hr.avg();
    s.max_hr = hr.max;
    s.avg_cad = cad.avg();
    s.avg_power = power.avg();
    s.max_power = power.max;
    s.avg_temp = temp.avg();
    s
}
