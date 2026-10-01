//! GPX dışındaki biçimler: Garmin FIT ve TCX ile Google Earth KML okuma,
//! TCX ve KML yazma. Hepsi aynı [`Gpx`] yapısına çevrilir.

use crate::parse::{parse_gpx, parse_time, Gpx, ParseError, Point, Track, Waypoint};
use crate::write::format_time;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::fmt::Write;

/// Açılabilen dosya uzantıları (küçük harf).
pub const SUPPORTED: [&str; 4] = ["gpx", "fit", "tcx", "kml"];

pub fn is_supported_ext(ext: &str) -> bool {
    SUPPORTED.contains(&ext.to_ascii_lowercase().as_str())
}

/// Uzantıya göre uygun okuyucuyu seçer; bilinmeyen uzantılar GPX sayılır.
pub fn parse_any(ext: &str, bytes: &[u8]) -> Result<Gpx, ParseError> {
    match ext.to_ascii_lowercase().as_str() {
        "fit" => parse_fit(bytes),
        "tcx" => parse_tcx(bytes),
        "kml" => parse_kml(bytes),
        _ => parse_gpx(bytes),
    }
}

// ---------- FIT ----------

pub fn parse_fit(bytes: &[u8]) -> Result<Gpx, ParseError> {
    use fitparser::profile::MesgNum;
    use fitparser::Value;
    let records = fitparser::from_bytes(bytes)
        .map_err(|e| ParseError(format!("FIT dosyası okunamadı: {e}")))?;
    const SEMI: f64 = 180.0 / 2_147_483_648.0;
    let num = |v: &Value| -> Option<f64> {
        let x: Result<f64, _> = v.clone().try_into();
        x.ok().filter(|x| x.is_finite())
    };
    let mut points = Vec::new();
    let mut sport: Option<String> = None;
    for r in &records {
        match r.kind() {
            MesgNum::Record => {
                let mut p = Point::default();
                let (mut lat, mut lon) = (None, None);
                let mut alt = None;
                for f in r.fields() {
                    let v = f.value();
                    match f.name() {
                        "position_lat" => lat = num(v).map(|x| x * SEMI),
                        "position_long" => lon = num(v).map(|x| x * SEMI),
                        // enhanced_altitude daha doğrudur; varsa onu tercih et.
                        "enhanced_altitude" => alt = num(v).or(alt),
                        "altitude" => alt = alt.or(num(v)),
                        "timestamp" => {
                            if let Value::Timestamp(t) = v {
                                p.time = Some(t.timestamp_millis());
                            }
                        }
                        "heart_rate" => p.hr = num(v).map(|x| x as f32),
                        "cadence" => p.cad = num(v).map(|x| x as f32),
                        "power" => p.power = num(v).map(|x| x as f32),
                        "temperature" => p.temp = num(v).map(|x| x as f32),
                        _ => {}
                    }
                }
                if let (Some(la), Some(lo)) = (lat, lon) {
                    if la.abs() <= 90.0 && lo.abs() <= 180.0 {
                        p.lat = la;
                        p.lon = lo;
                        p.ele = alt.map(|a| a as f32);
                        points.push(p);
                    }
                }
            }
            MesgNum::Sport | MesgNum::Session if sport.is_none() => {
                sport = r
                    .fields()
                    .iter()
                    .find(|f| f.name() == "sport")
                    .map(|f| f.value().to_string());
            }
            _ => {}
        }
    }
    if points.is_empty() {
        return Err(ParseError("FIT dosyasında konum kaydı yok".into()));
    }
    let time = points.iter().find_map(|p| p.time);
    let name = sport.map(|s| format!("FIT {s}"));
    Ok(Gpx {
        name: name.clone(),
        time,
        tracks: vec![Track {
            name,
            segments: vec![points],
        }],
        ..Gpx::default()
    })
}

// ---------- TCX ----------

pub fn parse_tcx(bytes: &[u8]) -> Result<Gpx, ParseError> {
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut gpx = Gpx::default();
    let mut seg: Vec<Point> = Vec::new();
    let mut segments: Vec<Vec<Point>> = Vec::new();
    let mut pt: Option<(Point, Option<f64>, Option<f64>)> = None;
    let mut text = String::new();
    let mut saw_root = false;
    let mut track_name: Option<String> = None;

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| ParseError(format!("TCX XML hatası: {e}")))?;
        match ev {
            Event::Start(e) => {
                let n = e.local_name().as_ref().to_vec();
                match n.as_slice() {
                    b"TrainingCenterDatabase" => saw_root = true,
                    b"Trackpoint" => pt = Some((Point::default(), None, None)),
                    b"Track" => seg = Vec::new(),
                    _ => {}
                }
                text.clear();
                stack.push(n);
            }
            Event::Text(t) => {
                if let Ok(s) = t.decode() {
                    text.push_str(&s);
                }
            }
            Event::End(_) => {
                let n = stack.pop().unwrap_or_default();
                let parent = stack.last().map(|v| v.as_slice());
                let v = text.trim();
                if let Some((p, lat, lon)) = pt.as_mut() {
                    match n.as_slice() {
                        b"Time" => p.time = parse_time(v),
                        b"LatitudeDegrees" => *lat = v.parse().ok(),
                        b"LongitudeDegrees" => *lon = v.parse().ok(),
                        b"AltitudeMeters" => p.ele = v.parse().ok(),
                        b"Value" if parent == Some(b"HeartRateBpm") => p.hr = v.parse().ok(),
                        b"Cadence" | b"RunCadence" => p.cad = v.parse().ok(),
                        b"Watts" => p.power = v.parse().ok(),
                        _ => {}
                    }
                }
                match n.as_slice() {
                    b"Trackpoint" => {
                        if let Some((mut p, Some(lat), Some(lon))) = pt.take() {
                            p.lat = lat;
                            p.lon = lon;
                            seg.push(p);
                        }
                        pt = None;
                    }
                    b"Track" => {
                        if !seg.is_empty() {
                            segments.push(std::mem::take(&mut seg));
                        }
                    }
                    // Etkinliğin kimliği başlangıç zamanıdır; rotalarda (Course) ad.
                    b"Name" if parent == Some(b"Course") && !v.is_empty() => {
                        track_name = Some(v.to_owned())
                    }
                    b"Id" if parent == Some(b"Activity") => gpx.time = parse_time(v),
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if !saw_root {
        return Err(ParseError("Geçerli bir TCX dosyası değil".into()));
    }
    gpx.name = track_name.clone();
    if !segments.is_empty() {
        gpx.tracks.push(Track {
            name: track_name,
            segments,
        });
    }
    Ok(gpx)
}

// ---------- KML ----------

/// "boylam,enlem[,yükseklik]" ya da gx:coord'daki "boylam enlem yükseklik".
fn kml_point(s: &str) -> Option<Point> {
    let parts: Vec<f64> = s
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|x| !x.is_empty())
        .map(|x| x.parse().ok())
        .collect::<Option<Vec<_>>>()?;
    let (lon, lat) = (*parts.first()?, *parts.get(1)?);
    if lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    Some(Point {
        lat,
        lon,
        ele: parts.get(2).map(|e| *e as f32),
        ..Point::default()
    })
}

pub fn parse_kml(bytes: &[u8]) -> Result<Gpx, ParseError> {
    let mut reader = Reader::from_reader(bytes);
    let mut buf = Vec::new();
    let mut stack: Vec<Vec<u8>> = Vec::new();
    let mut gpx = Gpx::default();
    let mut text = String::new();
    let mut saw_root = false;
    let mut placemark_name: Option<String> = None;
    let mut segments: Vec<Vec<Point>> = Vec::new();
    // gx:Track: zamanlar ve koordinatlar ayrı listeler halinde gelir.
    let mut whens: Vec<Option<i64>> = Vec::new();
    let mut coords: Vec<Point> = Vec::new();

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| ParseError(format!("KML XML hatası: {e}")))?;
        match ev {
            Event::Start(e) => {
                let n = e.local_name().as_ref().to_vec();
                match n.as_slice() {
                    b"kml" => saw_root = true,
                    b"Placemark" => placemark_name = None,
                    b"Track" => {
                        whens.clear();
                        coords.clear();
                    }
                    _ => {}
                }
                text.clear();
                stack.push(n);
            }
            Event::Text(t) => {
                if let Ok(s) = t.decode() {
                    text.push_str(&s);
                }
            }
            Event::End(_) => {
                let n = stack.pop().unwrap_or_default();
                let parent = stack.last().map(|v| v.as_slice());
                let v = text.trim();
                match n.as_slice() {
                    b"name" if parent == Some(b"Placemark") && !v.is_empty() => {
                        placemark_name = Some(v.to_owned())
                    }
                    b"name"
                        if matches!(parent, Some(b"Document" | b"Folder"))
                            && gpx.name.is_none() =>
                    {
                        gpx.name = Some(v.to_owned()).filter(|s| !s.is_empty())
                    }
                    b"coordinates" => {
                        let pts: Vec<Point> = v.split_whitespace().filter_map(kml_point).collect();
                        match parent {
                            Some(b"Point") => {
                                if let Some(p) = pts.first() {
                                    gpx.waypoints.push(Waypoint {
                                        point: *p,
                                        name: placemark_name.clone(),
                                    });
                                }
                            }
                            _ if pts.len() >= 2 => segments.push(pts),
                            _ => {}
                        }
                    }
                    b"when" if parent == Some(b"Track") => whens.push(parse_time(v)),
                    b"coord" if parent == Some(b"Track") => {
                        if let Some(p) = kml_point(v) {
                            coords.push(p);
                        }
                    }
                    b"Track" => {
                        let mut seg = std::mem::take(&mut coords);
                        for (p, t) in seg.iter_mut().zip(whens.iter()) {
                            p.time = *t;
                        }
                        if !seg.is_empty() {
                            segments.push(seg);
                        }
                    }
                    _ => {}
                }
                text.clear();
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }
    if !saw_root {
        return Err(ParseError("Geçerli bir KML dosyası değil".into()));
    }
    if !segments.is_empty() {
        gpx.time = segments.iter().flatten().find_map(|p| p.time);
        gpx.tracks.push(Track {
            name: placemark_name.or_else(|| gpx.name.clone()),
            segments,
        });
    }
    Ok(gpx)
}

// ---------- Yazıcılar ----------

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn primary(gpx: &Gpx) -> Vec<&[Point]> {
    crate::primary_segments(gpx)
}

/// KML 2.2; zaman bilgisi varsa gx:Track, yoksa LineString yazılır.
pub fn write_kml(gpx: &Gpx) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<kml xmlns=\"http://www.opengis.net/kml/2.2\" \
         xmlns:gx=\"http://www.google.com/kml/ext/2.2\">\n<Document>\n",
    );
    let name = gpx.name.clone().unwrap_or_else(|| "GPXer".into());
    let _ = writeln!(out, "<name>{}</name>", esc(&name));
    out.push_str(
        "<Style id=\"iz\"><LineStyle><color>ff3d55e8</color><width>4</width></LineStyle></Style>\n",
    );
    for w in &gpx.waypoints {
        let _ = writeln!(
            out,
            "<Placemark><name>{}</name><Point><coordinates>{},{}{}</coordinates></Point></Placemark>",
            esc(w.name.as_deref().unwrap_or("")),
            w.point.lon,
            w.point.lat,
            w.point.ele.map(|e| format!(",{e}")).unwrap_or_default()
        );
    }
    let _ = writeln!(
        out,
        "<Placemark><name>{}</name><styleUrl>#iz</styleUrl><MultiGeometry>",
        esc(&name)
    );
    for seg in primary(gpx) {
        if seg.iter().all(|p| p.time.is_some()) {
            out.push_str("<gx:Track><altitudeMode>clampToGround</altitudeMode>\n");
            for p in seg {
                let _ = writeln!(out, "<when>{}</when>", format_time(p.time.unwrap()));
            }
            for p in seg {
                let _ = writeln!(
                    out,
                    "<gx:coord>{} {} {}</gx:coord>",
                    p.lon,
                    p.lat,
                    p.ele.unwrap_or(0.0)
                );
            }
            out.push_str("</gx:Track>\n");
        } else {
            out.push_str("<LineString><tessellate>1</tessellate><coordinates>\n");
            for p in seg {
                let _ = writeln!(out, "{},{},{}", p.lon, p.lat, p.ele.unwrap_or(0.0));
            }
            out.push_str("</coordinates></LineString>\n");
        }
    }
    out.push_str("</MultiGeometry></Placemark>\n</Document>\n</kml>\n");
    out
}

/// Garmin TCX (Training Center); her segment bir Track olur.
pub fn write_tcx(gpx: &Gpx) -> String {
    let segs = primary(gpx);
    let start = segs
        .iter()
        .flat_map(|s| s.iter())
        .find_map(|p| p.time)
        .or(gpx.time);
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<TrainingCenterDatabase \
         xmlns=\"http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2\" \
         xmlns:ns3=\"http://www.garmin.com/xmlschemas/ActivityExtension/v2\">\n<Activities>\n\
         <Activity Sport=\"Other\">\n",
    );
    let id = start
        .map(format_time)
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    let _ = writeln!(out, "<Id>{id}</Id>\n<Lap StartTime=\"{id}\">");
    for seg in segs {
        out.push_str("<Track>\n");
        let mut dist = 0.0;
        for (i, p) in seg.iter().enumerate() {
            if i > 0 {
                dist += crate::haversine_m(&seg[i - 1], p);
            }
            out.push_str("<Trackpoint>");
            if let Some(t) = p.time {
                let _ = write!(out, "<Time>{}</Time>", format_time(t));
            }
            let _ = write!(
                out,
                "<Position><LatitudeDegrees>{}</LatitudeDegrees><LongitudeDegrees>{}</LongitudeDegrees></Position>",
                p.lat, p.lon
            );
            if let Some(e) = p.ele {
                let _ = write!(out, "<AltitudeMeters>{e}</AltitudeMeters>");
            }
            let _ = write!(out, "<DistanceMeters>{dist:.1}</DistanceMeters>");
            if let Some(h) = p.hr {
                let _ = write!(
                    out,
                    "<HeartRateBpm><Value>{}</Value></HeartRateBpm>",
                    h.round()
                );
            }
            if let Some(c) = p.cad {
                let _ = write!(out, "<Cadence>{}</Cadence>", c.round());
            }
            if let Some(w) = p.power {
                let _ = write!(
                    out,
                    "<Extensions><ns3:TPX><ns3:Watts>{}</ns3:Watts></ns3:TPX></Extensions>",
                    w.round()
                );
            }
            out.push_str("</Trackpoint>\n");
        }
        out.push_str("</Track>\n");
    }
    out.push_str("</Lap>\n</Activity>\n</Activities>\n</TrainingCenterDatabase>\n");
    out
}
