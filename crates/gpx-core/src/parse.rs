//! Akış tabanlı (streaming) GPX ayrıştırıcı.
//!
//! Tüm belgeyi DOM olarak belleğe almak yerine quick-xml ile olayları tek
//! geçişte okur; büyük günlük loglarda bile hızlı ve az bellekli çalışır.
//! Ad alanı önekleri yok sayılır (`gpx:trkpt` ile `trkpt` aynı kabul edilir).

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Point {
    pub lat: f64,
    pub lon: f64,
    pub ele: Option<f32>,
    /// Unix epoch milisaniye (UTC).
    pub time: Option<i64>,
    /// Sensör verileri (Garmin TrackPointExtension vb. uzantılardan).
    /// Nabız (atım/dk).
    pub hr: Option<f32>,
    /// Kadans (devir/dk ya da adım/dk).
    pub cad: Option<f32>,
    /// Güç (W).
    pub power: Option<f32>,
    /// Sıcaklık (°C).
    pub temp: Option<f32>,
}

/// Nokta uzantılarında okunan sensör alanları.
#[derive(Clone, Copy, PartialEq)]
enum Sensor {
    Hr,
    Cad,
    Power,
    Temp,
}

fn sensor_of(name: &[u8]) -> Option<Sensor> {
    match name {
        b"hr" | b"heartrate" => Some(Sensor::Hr),
        b"cad" | b"cadence" => Some(Sensor::Cad),
        b"power" | b"watts" => Some(Sensor::Power),
        b"atemp" | b"temp" | b"temperature" | b"wtemp" => Some(Sensor::Temp),
        _ => None,
    }
}

#[derive(Debug, Clone, Default)]
pub struct Track {
    pub name: Option<String>,
    pub segments: Vec<Vec<Point>>,
}

#[derive(Debug, Clone)]
pub struct Waypoint {
    pub point: Point,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Gpx {
    pub name: Option<String>,
    pub time: Option<i64>,
    pub tracks: Vec<Track>,
    pub routes: Vec<Track>,
    pub waypoints: Vec<Waypoint>,
}

#[derive(Debug)]
pub struct ParseError(pub String);

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

/// Ayrıştırıcının o an içinde bulunduğu nokta tipi.
#[derive(Clone, Copy, PartialEq)]
enum PointKind {
    Track,
    Route,
    Waypoint,
}

/// Metin içeriği toplanan alan.
#[derive(Clone, Copy, PartialEq)]
enum TextField {
    Name,
    Ele,
    Time,
    Sensor(Sensor),
}

fn local_name(e: &BytesStart) -> Vec<u8> {
    e.local_name().as_ref().to_vec()
}

fn read_lat_lon(e: &BytesStart) -> Option<(f64, f64)> {
    let mut lat = None;
    let mut lon = None;
    for attr in e.attributes().flatten() {
        let key = attr.key.local_name();
        let value = std::str::from_utf8(&attr.value).ok()?.trim().to_owned();
        match key.as_ref() {
            b"lat" => lat = value.parse::<f64>().ok(),
            b"lon" => lon = value.parse::<f64>().ok(),
            _ => {}
        }
    }
    match (lat, lon) {
        (Some(lat), Some(lon))
            if lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0 =>
        {
            Some((lat, lon))
        }
        _ => None,
    }
}

/// ISO 8601 / RFC 3339 zaman damgasını epoch milisaniyeye çevirir.
/// Saat dilimi belirtilmemişse UTC kabul edilir.
pub fn parse_time(s: &str) -> Option<i64> {
    let s = s.trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, fmt) {
            return Some(dt.and_utc().timestamp_millis());
        }
    }
    None
}

pub fn parse_gpx(bytes: &[u8]) -> Result<Gpx, ParseError> {
    let mut reader = Reader::from_reader(bytes);
    // Metin kırpılmaz: `&amp;` gibi referansların çevresindeki boşluklar
    // korunmalı. Değerler kullanılırken ayrıca kırpılıyor.

    let mut gpx = Gpx::default();
    let mut stack: Vec<Vec<u8>> = Vec::with_capacity(8);
    let mut buf = Vec::new();

    let mut current_track: Option<Track> = None;
    let mut current_track_is_route = false;
    let mut current_segment: Option<Vec<Point>> = None;

    let mut point: Option<(PointKind, Point)> = None;
    let mut point_name: Option<String> = None;

    let mut text_field: Option<TextField> = None;
    let mut text = String::new();
    let mut saw_gpx_root = false;

    loop {
        let event = reader.read_event_into(&mut buf).map_err(|e| {
            ParseError(format!(
                "XML hatası (konum {}): {e}",
                reader.buffer_position()
            ))
        })?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let is_empty = matches!(event, Event::Empty(_));
                let name = local_name(e);
                let parent = stack.last().map(|v| v.as_slice());
                match name.as_slice() {
                    b"gpx" => saw_gpx_root = true,
                    b"trk" => {
                        current_track = Some(Track::default());
                        current_track_is_route = false;
                    }
                    b"rte" => {
                        current_track = Some(Track {
                            name: None,
                            segments: vec![Vec::new()],
                        });
                        current_track_is_route = true;
                    }
                    b"trkseg" if current_track.is_some() => current_segment = Some(Vec::new()),
                    b"trkpt" | b"rtept" | b"wpt" => {
                        let kind = match name.as_slice() {
                            b"trkpt" => PointKind::Track,
                            b"rtept" => PointKind::Route,
                            _ => PointKind::Waypoint,
                        };
                        point = read_lat_lon(e).map(|(lat, lon)| {
                            (
                                kind,
                                Point {
                                    lat,
                                    lon,
                                    ..Point::default()
                                },
                            )
                        });
                        point_name = None;
                    }
                    b"ele" if point.is_some() => text_field = Some(TextField::Ele),
                    other if point.is_some() && sensor_of(other).is_some() => {
                        text_field = sensor_of(other).map(TextField::Sensor)
                    }
                    b"time"
                        if point.is_some()
                            || parent == Some(b"metadata")
                            || parent == Some(b"gpx") =>
                    {
                        text_field = Some(TextField::Time)
                    }
                    b"name"
                        if matches!(
                            parent,
                            Some(
                                b"trk"
                                    | b"rte"
                                    | b"wpt"
                                    | b"rtept"
                                    | b"trkpt"
                                    | b"metadata"
                                    | b"gpx"
                            )
                        ) =>
                    {
                        text_field = Some(TextField::Name)
                    }
                    _ => {}
                }
                text.clear();
                if is_empty {
                    // Kendiliğinden kapanan etiket: End olayı gelmeyecek.
                    close_element(
                        &name,
                        &stack,
                        &mut gpx,
                        &mut current_track,
                        current_track_is_route,
                        &mut current_segment,
                        &mut point,
                        &mut point_name,
                        &mut text_field,
                        &text,
                    );
                } else {
                    stack.push(name);
                }
            }
            Event::Text(t) => {
                if text_field.is_some() {
                    if let Ok(s) = t.decode() {
                        text.push_str(&s);
                    }
                }
            }
            Event::CData(t) => {
                if text_field.is_some() {
                    text.push_str(&String::from_utf8_lossy(&t));
                }
            }
            Event::GeneralRef(r) => {
                if text_field.is_some() {
                    match r.as_ref() {
                        b"amp" => text.push('&'),
                        b"lt" => text.push('<'),
                        b"gt" => text.push('>'),
                        b"quot" => text.push('"'),
                        b"apos" => text.push('\''),
                        other => {
                            if let Ok(Some(c)) = r.resolve_char_ref() {
                                text.push(c);
                            } else {
                                text.push('&');
                                text.push_str(&String::from_utf8_lossy(other));
                                text.push(';');
                            }
                        }
                    }
                }
            }
            Event::End(_) => {
                let name = stack.pop().unwrap_or_default();
                close_element(
                    &name,
                    &stack,
                    &mut gpx,
                    &mut current_track,
                    current_track_is_route,
                    &mut current_segment,
                    &mut point,
                    &mut point_name,
                    &mut text_field,
                    &text,
                );
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    if !saw_gpx_root {
        return Err(ParseError(
            "Geçerli bir GPX dosyası değil (<gpx> kökü bulunamadı)".into(),
        ));
    }
    Ok(gpx)
}

#[allow(clippy::too_many_arguments)]
fn close_element(
    name: &[u8],
    stack: &[Vec<u8>],
    gpx: &mut Gpx,
    current_track: &mut Option<Track>,
    current_track_is_route: bool,
    current_segment: &mut Option<Vec<Point>>,
    point: &mut Option<(PointKind, Point)>,
    point_name: &mut Option<String>,
    text_field: &mut Option<TextField>,
    text: &str,
) {
    let parent = stack.last().map(|v| v.as_slice());
    match name {
        b"ele" if *text_field == Some(TextField::Ele) => {
            if let Some((_, p)) = point.as_mut() {
                p.ele = text.trim().parse::<f32>().ok().filter(|v| v.is_finite());
            }
            *text_field = None;
        }
        other
            if matches!(*text_field, Some(TextField::Sensor(_))) && sensor_of(other).is_some() =>
        {
            if let (Some(TextField::Sensor(kind)), Some((_, p))) = (*text_field, point.as_mut()) {
                let v = text
                    .split_whitespace()
                    .next()
                    .and_then(|t| t.parse::<f32>().ok())
                    .filter(|v| v.is_finite());
                match kind {
                    Sensor::Hr => p.hr = v.filter(|v| *v > 0.0),
                    Sensor::Cad => p.cad = v,
                    Sensor::Power => p.power = v,
                    Sensor::Temp => p.temp = v,
                }
            }
            *text_field = None;
        }
        b"time" if *text_field == Some(TextField::Time) => {
            let t = parse_time(text);
            if let Some((_, p)) = point.as_mut() {
                p.time = t;
            } else if gpx.time.is_none() {
                gpx.time = t;
            }
            *text_field = None;
        }
        b"name" if *text_field == Some(TextField::Name) => {
            let value = text.trim();
            if !value.is_empty() {
                let value = value.to_owned();
                match parent {
                    Some(b"wpt" | b"rtept" | b"trkpt") => *point_name = Some(value),
                    Some(b"trk" | b"rte") => {
                        if let Some(t) = current_track.as_mut() {
                            t.name = Some(value);
                        }
                    }
                    Some(b"metadata" | b"gpx") if gpx.name.is_none() => gpx.name = Some(value),
                    _ => {}
                }
            }
            *text_field = None;
        }
        b"trkpt" | b"rtept" | b"wpt" => {
            if let Some((kind, p)) = point.take() {
                match kind {
                    PointKind::Track => {
                        if let Some(seg) = current_segment.as_mut() {
                            seg.push(p);
                        }
                    }
                    PointKind::Route => {
                        if let Some(seg) =
                            current_track.as_mut().and_then(|t| t.segments.last_mut())
                        {
                            seg.push(p);
                        }
                    }
                    PointKind::Waypoint => gpx.waypoints.push(Waypoint {
                        point: p,
                        name: point_name.take(),
                    }),
                }
            }
            *point_name = None;
        }
        b"trkseg" => {
            if let (Some(seg), Some(track)) = (current_segment.take(), current_track.as_mut()) {
                if !seg.is_empty() {
                    track.segments.push(seg);
                }
            }
        }
        b"trk" | b"rte" => {
            if let Some(mut track) = current_track.take() {
                track.segments.retain(|s| !s.is_empty());
                if !track.segments.is_empty() {
                    if current_track_is_route {
                        gpx.routes.push(track);
                    } else {
                        gpx.tracks.push(track);
                    }
                }
            }
        }
        _ => {}
    }
}
