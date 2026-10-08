//! Google Konum Geçmişi (Takeout) JSON dosyaları. Üç biçim okunur ve tek bir
//! zamana göre sıralı ize çevrilir:
//!
//! - Eski ham kayıt: `Records.json` (`locations`: `latitudeE7`, `longitudeE7`,
//!   `timestamp` ya da `timestampMs`, `accuracy`, `altitude`).
//! - Anlamsal geçmiş: aylık `2019_JUNE.json` (`timelineObjects`: yolculukların
//!   `simplifiedRawPath`/`waypointPath` noktaları, duraklama yerleri).
//! - Telefondaki yeni Zaman Çizelgesi dışa aktarımı: Android (`[{startTime,
//!   activity, visit, timelinePath}]`, `"geo:41.0,29.0"`) ve iOS
//!   (`semanticSegments`, `rawSignals`, `"41.0°, 29.0°"`).

use crate::parse::{parse_time, Gpx, ParseError, Point, Track};
use serde::Deserialize;
use serde_json::Value;

/// Bu doğruluktan (m) kötü ham konumlar (baz istasyonu tahmini) atılır.
const MAX_ACCURACY_M: f64 = 1000.0;

#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Root {
    locations: Option<Vec<Record>>,
    timeline_objects: Option<Vec<Value>>,
    semantic_segments: Option<Vec<Value>>,
    raw_signals: Option<Vec<Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(rename = "latitudeE7")]
    lat_e7: Option<i64>,
    #[serde(rename = "longitudeE7")]
    lon_e7: Option<i64>,
    timestamp: Option<String>,
    timestamp_ms: Option<String>,
    accuracy: Option<f64>,
    altitude: Option<f64>,
}

/// Klasör taranırken hangi JSON dosyalarının konum geçmişi sayılacağı (her
/// JSON dosyası açılmaya çalışılmasın): Takeout ve telefonun verdiği adlar
/// (Records.json, Timeline.json, location-history.json, aylık 2019_JUNE.json).
pub fn is_google_file_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let Some(stem) = n.strip_suffix(".json") else {
        return false;
    };
    ["records", "timeline", "location", "konum", "zaman"]
        .iter()
        .any(|k| stem.contains(k))
        || stem.split_once('_').is_some_and(|(y, m)| {
            y.len() == 4
                && y.bytes().all(|c| c.is_ascii_digit())
                && m.bytes().all(|c| c.is_ascii_alphabetic())
        })
}

pub fn parse_google(bytes: &[u8]) -> Result<Gpx, ParseError> {
    let not_google = || ParseError("Google konum geçmişi (Takeout JSON) değil".into());
    let first = bytes.iter().find(|b| !b.is_ascii_whitespace()).copied();
    let mut pts: Vec<Point> = Vec::new();
    match first {
        Some(b'[') => {
            let items: Vec<Value> = serde_json::from_slice(bytes)
                .map_err(|e| ParseError(format!("JSON okunamadı: {e}")))?;
            for it in &items {
                android_item(it, &mut pts);
            }
        }
        Some(b'{') => {
            let root: Root = serde_json::from_slice(bytes)
                .map_err(|e| ParseError(format!("JSON okunamadı: {e}")))?;
            if root.locations.is_none()
                && root.timeline_objects.is_none()
                && root.semantic_segments.is_none()
                && root.raw_signals.is_none()
            {
                return Err(not_google());
            }
            for r in root.locations.iter().flatten() {
                if r.accuracy.is_some_and(|a| a > MAX_ACCURACY_M) {
                    continue;
                }
                let time = r
                    .timestamp
                    .as_deref()
                    .and_then(parse_time)
                    .or_else(|| r.timestamp_ms.as_deref().and_then(|s| s.parse().ok()));
                if let (Some(la), Some(lo)) = (r.lat_e7, r.lon_e7) {
                    push(&mut pts, e7(la), e7(lo), time, r.altitude);
                }
            }
            for o in root.timeline_objects.iter().flatten() {
                semantic_object(o, &mut pts);
            }
            for s in root.semantic_segments.iter().flatten() {
                ios_segment(s, &mut pts);
            }
            for s in root.raw_signals.iter().flatten() {
                let p = &s["position"];
                if let Some((la, lo)) = p["LatLng"].as_str().and_then(deg_pair) {
                    let alt = p["altitudeMeters"].as_f64();
                    let acc = p["accuracyMeters"].as_f64();
                    if acc.is_some_and(|a| a > MAX_ACCURACY_M) {
                        continue;
                    }
                    push(
                        &mut pts,
                        la,
                        lo,
                        p["timestamp"].as_str().and_then(parse_time),
                        alt,
                    );
                }
            }
        }
        _ => return Err(not_google()),
    }
    if pts.is_empty() {
        return Err(ParseError("Konum geçmişinde zamanı olan nokta yok".into()));
    }
    // Biçimler (yolculuk yolu, duraklar, ham konumlar) iç içe gelir: zamana
    // göre sıralanır, aynı an ve yerdeki tekrarlar atılır.
    pts.sort_by_key(|p| p.time);
    pts.dedup_by(|b, a| a.time == b.time && a.lat == b.lat && a.lon == b.lon);
    let name = match (
        pts.first().and_then(|p| p.time),
        pts.last().and_then(|p| p.time),
    ) {
        (Some(a), Some(b)) => Some(format!(
            "Google konum geçmişi {} – {}",
            crate::write::format_time(a).get(..10).unwrap_or_default(),
            crate::write::format_time(b).get(..10).unwrap_or_default()
        )),
        _ => Some("Google konum geçmişi".into()),
    };
    Ok(Gpx {
        name: name.clone(),
        time: pts.first().and_then(|p| p.time),
        tracks: vec![Track {
            name,
            segments: vec![pts],
        }],
        ..Default::default()
    })
}

/// Konum geçmişini (tek iz) UTC aylarına böler: ("2019-06", ayın kaydı).
/// Yıllara yayılan geçmiş tek dev kayıt yerine aylık kayıtlar olarak
/// eklenir; tek aylık geçmiş için tek öğe döner.
pub fn split_by_month(gpx: Gpx) -> Vec<(String, Gpx)> {
    let mut out: Vec<(String, Vec<Point>)> = Vec::new();
    for p in gpx.tracks.into_iter().flat_map(|t| t.segments).flatten() {
        let Some(t) = p.time else { continue };
        let Some(key) = crate::write::format_time(t).get(..7).map(str::to_owned) else {
            continue;
        };
        match out.last_mut() {
            Some((k, pts)) if *k == key => pts.push(p),
            _ => out.push((key, vec![p])),
        }
    }
    out.into_iter()
        .map(|(key, pts)| {
            let name = Some(format!("Google konum geçmişi {key}"));
            let g = Gpx {
                name: name.clone(),
                time: pts.first().and_then(|p| p.time),
                tracks: vec![Track {
                    name,
                    segments: vec![pts],
                }],
                ..Default::default()
            };
            (key, g)
        })
        .collect()
}

fn e7(v: i64) -> f64 {
    v as f64 / 1e7
}

fn push(pts: &mut Vec<Point>, lat: f64, lon: f64, time: Option<i64>, ele: Option<f64>) {
    // Zamansız noktalar sıralanamaz (tek bir izde nereye düştüğü bilinmez);
    // bozuk zaman damgaları (1990 öncesi, 2100 sonrası) atılır.
    let Some(time) = time.filter(|t| (631_152_000_000..4_102_444_800_000).contains(t)) else {
        return;
    };
    if !(lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0)
        || (lat == 0.0 && lon == 0.0)
    {
        return;
    }
    pts.push(Point {
        lat,
        lon,
        time: Some(time),
        ele: ele.filter(|e| e.is_finite()).map(|e| e as f32),
        ..Default::default()
    });
}

/// `"geo:41.0,29.0"` ya da `"41.0°, 29.0°"`.
fn deg_pair(s: &str) -> Option<(f64, f64)> {
    let s = s.trim().trim_start_matches("geo:");
    let (a, b) = s.split_once(',')?;
    let num = |x: &str| x.trim().trim_end_matches('°').trim().parse::<f64>().ok();
    Some((num(a)?, num(b)?))
}

/// Anlamsal geçmişteki E7 konum nesnesi.
fn e7_obj(v: &Value) -> Option<(f64, f64)> {
    let la = v["latitudeE7"].as_i64().or_else(|| v["latE7"].as_i64())?;
    let lo = v["longitudeE7"].as_i64().or_else(|| v["lngE7"].as_i64())?;
    Some((e7(la), e7(lo)))
}

fn ts(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| parse_time(s).or_else(|| s.parse().ok()))
        .or_else(|| v.as_i64())
}

fn semantic_object(o: &Value, pts: &mut Vec<Point>) {
    if let Some(seg) = o.get("activitySegment") {
        let start = ts(&seg["duration"]["startTimestamp"])
            .or_else(|| ts(&seg["duration"]["startTimestampMs"]));
        let end =
            ts(&seg["duration"]["endTimestamp"]).or_else(|| ts(&seg["duration"]["endTimestampMs"]));
        if let Some((la, lo)) = e7_obj(&seg["startLocation"]) {
            push(pts, la, lo, start, None);
        }
        let raw = seg["simplifiedRawPath"]["points"].as_array();
        if let Some(raw) = raw.filter(|r| !r.is_empty()) {
            for p in raw {
                if let Some((la, lo)) = e7_obj(p) {
                    let t = ts(&p["timestamp"]).or_else(|| ts(&p["timestampMs"]));
                    push(pts, la, lo, t, None);
                }
            }
        } else if let (Some(w), Some(a), Some(b)) =
            (seg["waypointPath"]["waypoints"].as_array(), start, end)
        {
            // Yol noktalarının zamanı yok: başlangıç ile bitiş arasına eşit dağıtılır.
            let n = w.len() as i64 + 1;
            for (k, p) in w.iter().enumerate() {
                if let Some((la, lo)) = e7_obj(p) {
                    push(
                        pts,
                        la,
                        lo,
                        Some(a.saturating_add(b.saturating_sub(a) / n * (k as i64 + 1))),
                        None,
                    );
                }
            }
        }
        if let Some((la, lo)) = e7_obj(&seg["endLocation"]) {
            push(pts, la, lo, end, None);
        }
    }
    if let Some(v) = o.get("placeVisit") {
        if let Some((la, lo)) = e7_obj(&v["location"]) {
            for k in [
                "startTimestamp",
                "endTimestamp",
                "startTimestampMs",
                "endTimestampMs",
            ] {
                push(pts, la, lo, ts(&v["duration"][k]), None);
            }
        }
    }
}

/// Android Zaman Çizelgesi öğesi.
fn android_item(it: &Value, pts: &mut Vec<Point>) {
    let start = it["startTime"].as_str().and_then(parse_time);
    let end = it["endTime"].as_str().and_then(parse_time);
    if let Some(a) = it.get("activity") {
        if let Some((la, lo)) = a["start"].as_str().and_then(deg_pair) {
            push(pts, la, lo, start, None);
        }
        if let Some((la, lo)) = a["end"].as_str().and_then(deg_pair) {
            push(pts, la, lo, end, None);
        }
    }
    if let Some(v) = it.get("visit") {
        if let Some((la, lo)) = v["topCandidate"]["placeLocation"]
            .as_str()
            .and_then(deg_pair)
        {
            push(pts, la, lo, start, None);
            push(pts, la, lo, end, None);
        }
    }
    if let (Some(path), Some(s)) = (it["timelinePath"].as_array(), start) {
        for p in path {
            let off: Option<i64> = p["durationMinutesOffsetFromStartTime"]
                .as_str()
                .and_then(|x| x.parse().ok())
                .or_else(|| p["durationMinutesOffsetFromStartTime"].as_i64());
            if let (Some((la, lo)), Some(m)) = (p["point"].as_str().and_then(deg_pair), off) {
                push(
                    pts,
                    la,
                    lo,
                    Some(s.saturating_add(m.saturating_mul(60_000))),
                    None,
                );
            }
        }
    }
}

/// iOS Zaman Çizelgesi bölümü.
fn ios_segment(s: &Value, pts: &mut Vec<Point>) {
    let start = s["startTime"].as_str().and_then(parse_time);
    let end = s["endTime"].as_str().and_then(parse_time);
    for p in s["timelinePath"].as_array().into_iter().flatten() {
        if let Some((la, lo)) = p["point"].as_str().and_then(deg_pair) {
            push(pts, la, lo, p["time"].as_str().and_then(parse_time), None);
        }
    }
    if let Some((la, lo)) = s["visit"]["topCandidate"]["placeLocation"]["latLng"]
        .as_str()
        .and_then(deg_pair)
    {
        push(pts, la, lo, start, None);
        push(pts, la, lo, end, None);
    }
    if let Some(a) = s.get("activity") {
        if let Some((la, lo)) = a["start"]["latLng"].as_str().and_then(deg_pair) {
            push(pts, la, lo, start, None);
        }
        if let Some((la, lo)) = a["end"]["latLng"].as_str().and_then(deg_pair) {
            push(pts, la, lo, end, None);
        }
    }
}
