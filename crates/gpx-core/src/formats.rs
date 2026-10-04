//! GPX dışındaki biçimler: Garmin FIT ve TCX ile Google Earth KML okuma,
//! TCX ve KML yazma. Hepsi aynı [`Gpx`] yapısına çevrilir.

use crate::parse::{parse_gpx, parse_time, Gpx, ParseError, Point, Track, Waypoint};
use crate::primary_segments;
use crate::write::{esc, format_time, Sink};
use quick_xml::events::Event;
use quick_xml::Reader;

/// Açılabilen dosya uzantıları (küçük harf).
/// `json`: Google Konum Geçmişi (Takeout).
pub const SUPPORTED: [&str; 5] = ["gpx", "fit", "tcx", "kml", "json"];

pub fn is_supported_ext(ext: &str) -> bool {
    format_of_ext(ext).is_some()
}

/// Uzantının biçimi (küçük harf). macOS'un kopya adlarındaki sayı eki de
/// tanınır: "gpx 2", "GPX 3" → "gpx".
pub fn format_of_ext(ext: &str) -> Option<&'static str> {
    let lower = ext.to_ascii_lowercase();
    let base = match lower.rsplit_once(' ') {
        Some((b, n)) if !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()) => b,
        _ => lower.as_str(),
    };
    SUPPORTED.iter().copied().find(|s| *s == base)
}

/// Uzantıya göre uygun okuyucuyu seçer; bilinmeyen uzantılar GPX sayılır.
pub fn parse_any(ext: &str, bytes: &[u8]) -> Result<Gpx, ParseError> {
    match format_of_ext(ext).unwrap_or("gpx") {
        "fit" => parse_fit(bytes),
        "tcx" => parse_tcx(bytes),
        "kml" => parse_kml(bytes),
        "json" => crate::google::parse_google(bytes),
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
    let mut segments: Vec<Vec<Point>> = vec![Vec::new()];
    // Zamanlayıcı durduktan sonra gelen kayıtlar yeni segmente başlar.
    let mut stopped = false;
    // Kadansın kesirli kısmı (devir/dk), noktalarla aynı sırada.
    let mut fractions: Vec<Option<f32>> = Vec::new();
    let mut sport: Option<String> = None;
    // Koşu dinamikleri (adım uzunluğu vb.) varsa kayıt koşudur.
    let mut running_dynamics = false;
    for r in &records {
        match r.kind() {
            MesgNum::Record => {
                let mut p = Point::default();
                let (mut lat, mut lon) = (None, None);
                let mut alt = None;
                let mut frac = None;
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
                        "fractional_cadence" => frac = num(v).map(|x| x as f32),
                        "step_length" | "vertical_oscillation" | "stance_time" => {
                            running_dynamics |= num(v).is_some_and(|x| x > 0.0)
                        }
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
                        if std::mem::take(&mut stopped)
                            && segments.last().is_some_and(|s| !s.is_empty())
                        {
                            segments.push(Vec::new());
                        }
                        segments.last_mut().unwrap().push(p);
                        fractions.push(frac);
                    }
                }
            }
            MesgNum::Event => {
                let field = |name: &str| {
                    r.fields()
                        .iter()
                        .find(|f| f.name() == name)
                        .map(|f| f.value().to_string())
                };
                let timer = matches!(field("event").as_deref(), Some("timer" | "0"));
                let stop = matches!(
                    field("event_type").as_deref(),
                    Some(
                        "stop"
                            | "stop_all"
                            | "stop_disable"
                            | "stop_disable_all"
                            | "1"
                            | "4"
                            | "8"
                            | "9"
                    )
                );
                if timer && stop {
                    stopped = true;
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
    segments.retain(|s| !s.is_empty());
    if segments.is_empty() {
        return Err(ParseError("FIT dosyasında konum kaydı yok".into()));
    }
    // Koşuda FIT kadansı tek bacağın adım sayısıdır (adım/dk'nın yarısı).
    let running = match sport.as_deref() {
        Some(s) => {
            let s = s.to_ascii_lowercase();
            s.contains("run") || (matches!(s.as_str(), "generic" | "0") && running_dynamics)
        }
        None => running_dynamics,
    };
    if running {
        for (p, frac) in segments.iter_mut().flatten().zip(&fractions) {
            if let Some(c) = p.cad.as_mut() {
                *c = (*c + frac.unwrap_or(0.0)) * 2.0;
            }
        }
    }
    let time = segments.iter().flatten().find_map(|p| p.time);
    let name = sport.map(|s| format!("FIT {s}"));
    Ok(Gpx {
        name: name.clone(),
        time,
        tracks: vec![Track { name, segments }],
        ..Gpx::default()
    })
}

// ---------- TCX ----------

/// Sonlu bir sayı (NaN ve sonsuz kabul edilmez).
fn finite(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|x| x.is_finite())
}

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
                        b"LatitudeDegrees" => *lat = finite(v).filter(|x| x.abs() <= 90.0),
                        b"LongitudeDegrees" => *lon = finite(v).filter(|x| x.abs() <= 180.0),
                        b"AltitudeMeters" => p.ele = finite(v).map(|x| x as f32),
                        b"Value" if parent == Some(b"HeartRateBpm") => {
                            p.hr = finite(v).map(|x| x as f32)
                        }
                        b"Cadence" | b"RunCadence" => p.cad = finite(v).map(|x| x as f32),
                        b"Watts" => p.power = finite(v).map(|x| x as f32),
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
        .map(finite)
        .collect::<Option<Vec<_>>>()?;
    let (lon, lat) = (*parts.first()?, *parts.get(1)?);
    if lat.abs() > 90.0 || lon.abs() > 180.0 {
        return None;
    }
    Some(Point {
        lat,
        lon,
        ele: parts.get(2).map(|e| *e as f32).filter(|e| e.is_finite()),
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
    // İz adı: iz içeren ilk Placemark'ın adı.
    let mut track_name: Option<String> = None;
    let mut placemark_segments = 0;
    let mut segments: Vec<Vec<Point>> = Vec::new();
    // gx:Track: zamanlar ve koordinatlar ayrı listeler halinde gelir;
    // okunamayan bir değer sıralamayı kaydırmasın diye ikisi de tutulur.
    let mut whens: Vec<Option<i64>> = Vec::new();
    let mut coords: Vec<Option<Point>> = Vec::new();
    // gx:Track sensör dizileri (ExtendedData/SchemaData/gx:SimpleArrayData):
    // ad ve nokta sırasıyla değerler.
    let mut arrays: Vec<(String, Vec<Option<f32>>)> = Vec::new();

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| ParseError(format!("KML XML hatası: {e}")))?;
        match ev {
            Event::Start(e) => {
                let n = e.local_name().as_ref().to_vec();
                match n.as_slice() {
                    b"kml" => saw_root = true,
                    b"Placemark" => {
                        placemark_name = None;
                        placemark_segments = segments.len();
                    }
                    b"Track" => {
                        whens.clear();
                        coords.clear();
                        arrays.clear();
                    }
                    b"SimpleArrayData" => {
                        let name = e
                            .attributes()
                            .flatten()
                            .find(|a| a.key.local_name().as_ref() == b"name")
                            .and_then(|a| {
                                std::str::from_utf8(&a.value)
                                    .ok()
                                    .map(str::to_ascii_lowercase)
                            })
                            .unwrap_or_default();
                        arrays.push((name, Vec::new()));
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
            // Boş sensör değeri (<gx:value/>): sıra kaymasın diye yer tutar.
            Event::Empty(e)
                if e.local_name().as_ref() == b"value"
                    && stack.last().map(|v| v.as_slice()) == Some(b"SimpleArrayData") =>
            {
                if let Some((_, vals)) = arrays.last_mut() {
                    vals.push(None);
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
                    b"coord" if parent == Some(b"Track") => coords.push(kml_point(v)),
                    b"value" if parent == Some(b"SimpleArrayData") => {
                        if let Some((_, vals)) = arrays.last_mut() {
                            vals.push(v.parse::<f32>().ok().filter(|x| x.is_finite()));
                        }
                    }
                    b"Track" => {
                        let seg: Vec<Point> = std::mem::take(&mut coords)
                            .into_iter()
                            .enumerate()
                            .filter_map(|(i, p)| {
                                let mut p = p?;
                                p.time = whens.get(i).copied().flatten();
                                for (name, vals) in &arrays {
                                    let v = vals.get(i).copied().flatten();
                                    match name.as_str() {
                                        "heartrate" | "heart_rate" | "hr" => p.hr = v,
                                        "cadence" | "cad" => p.cad = v,
                                        "power" | "watts" => p.power = v,
                                        "temperature" | "temp" | "atemp" => p.temp = v,
                                        _ => {}
                                    }
                                }
                                Some(p)
                            })
                            .collect();
                        if !seg.is_empty() {
                            segments.push(seg);
                        }
                    }
                    b"Placemark" if segments.len() > placemark_segments && track_name.is_none() => {
                        track_name = placemark_name.clone();
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
            name: track_name.or_else(|| gpx.name.clone()),
            segments,
        });
    }
    Ok(gpx)
}

// ---------- Yazıcılar ----------

/// gx:Track sensör dizileri (Google'ın KML uzantısı; My Tracks/Garmin adları).
struct KmlSensor {
    name: &'static str,
    label: &'static str,
    get: fn(&Point) -> Option<f32>,
}

const KML_SENSORS: [KmlSensor; 4] = [
    KmlSensor {
        name: "heartrate",
        label: "Nabız",
        get: |p| p.hr,
    },
    KmlSensor {
        name: "cadence",
        label: "Kadans",
        get: |p| p.cad,
    },
    KmlSensor {
        name: "power",
        label: "Güç",
        get: |p| p.power,
    },
    KmlSensor {
        name: "temperature",
        label: "Sıcaklık",
        get: |p| p.temp,
    },
];

/// KML 2.2; zaman bilgisi varsa gx:Track (sensör verisiyle), yoksa
/// LineString yazılır.
pub fn write_kml(gpx: &Gpx) -> String {
    let mut out = String::new();
    write_kml_into(gpx, &mut out);
    out
}

/// KML'i bellekte tamamını tutmadan `w`'ye yazar.
pub fn write_kml_to<W: std::io::Write>(gpx: &Gpx, w: &mut W) -> std::io::Result<()> {
    crate::write::stream(w, |s| write_kml_into(gpx, s))
}

fn write_kml_into<S: Sink + ?Sized>(gpx: &Gpx, out: &mut S) {
    out.push_str(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<kml xmlns=\"http://www.opengis.net/kml/2.2\" \
         xmlns:gx=\"http://www.google.com/kml/ext/2.2\">\n<Document>\n",
    );
    let name = gpx
        .name
        .clone()
        .or_else(|| {
            gpx.tracks
                .iter()
                .chain(&gpx.routes)
                .find_map(|t| t.name.clone())
        })
        .unwrap_or_else(|| "GPXer".into());
    let _ = writeln!(out, "<name>{}</name>", esc(&name));
    out.push_str(
        "<Style id=\"iz\"><LineStyle><color>ff3d55e8</color><width>4</width></LineStyle></Style>\n",
    );
    let segs = primary_segments(gpx);
    let used: Vec<&KmlSensor> = KML_SENSORS
        .iter()
        .filter(|s| {
            segs.iter()
                .flat_map(|g| g.iter())
                .any(|p| (s.get)(p).is_some())
        })
        .collect();
    if !used.is_empty() {
        out.push_str("<Schema id=\"sensors\">");
        for s in &used {
            let _ = write!(
                out,
                "<gx:SimpleArrayField name=\"{}\" type=\"float\"><displayName>{}</displayName></gx:SimpleArrayField>",
                s.name, s.label
            );
        }
        out.push_str("</Schema>\n");
    }
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
    for seg in segs {
        // Tek noktalı çizgi KML'de geçersiz: nokta olarak yazılır.
        if let [p] = seg {
            let _ = writeln!(
                out,
                "<Point><coordinates>{},{}{}</coordinates></Point>",
                p.lon,
                p.lat,
                p.ele.map(|e| format!(",{e}")).unwrap_or_default()
            );
            continue;
        }
        // Zamanlı noktalar gx:Track, zamansızlar LineString olarak yazılır;
        // karışık segment parçalara bölünür (eskiden tüm zamanlar atılıyordu).
        // Zamansız parça komşu noktaları da içerir ki çizgi kopmasın.
        let mut a = 0;
        while a < seg.len() {
            let timed = seg[a].time.is_some();
            let mut b = a;
            while b < seg.len() && seg[b].time.is_some() == timed {
                b += 1;
            }
            if timed && b - a >= 2 {
                kml_track(out, &seg[a..b], &used);
            } else {
                kml_line(out, &seg[a.saturating_sub(1)..(b + 1).min(seg.len())]);
            }
            a = b;
        }
    }
    out.push_str("</MultiGeometry></Placemark>\n</Document>\n</kml>\n");
}

/// gx:Track: zamanlar, koordinatlar ve sensör dizileri.
fn kml_track<S: Sink + ?Sized>(out: &mut S, seg: &[Point], used: &[&KmlSensor]) {
    out.push_str("<gx:Track><altitudeMode>clampToGround</altitudeMode>\n");
    for p in seg {
        let _ = writeln!(out, "<when>{}</when>", format_time(p.time.unwrap()));
    }
    for p in seg {
        // Yükseklik bilinmiyorsa yazılmaz (0 m sanılmasın).
        let _ = writeln!(
            out,
            "<gx:coord>{} {}{}</gx:coord>",
            p.lon,
            p.lat,
            p.ele.map(|e| format!(" {e}")).unwrap_or_default()
        );
    }
    let here: Vec<&&KmlSensor> = used
        .iter()
        .filter(|s| seg.iter().any(|p| (s.get)(p).is_some()))
        .collect();
    if !here.is_empty() {
        out.push_str("<ExtendedData><SchemaData schemaUrl=\"#sensors\">\n");
        for s in here {
            let _ = write!(out, "<gx:SimpleArrayData name=\"{}\">", s.name);
            for p in seg {
                match (s.get)(p) {
                    Some(v) => {
                        let _ = write!(out, "<gx:value>{v}</gx:value>");
                    }
                    None => out.push_str("<gx:value/>"),
                }
            }
            out.push_str("</gx:SimpleArrayData>\n");
        }
        out.push_str("</SchemaData></ExtendedData>\n");
    }
    out.push_str("</gx:Track>\n");
}

/// Zamansız noktalar için LineString.
fn kml_line<S: Sink + ?Sized>(out: &mut S, seg: &[Point]) {
    out.push_str("<LineString><tessellate>1</tessellate><coordinates>\n");
    for p in seg {
        let _ = writeln!(
            out,
            "{},{}{}",
            p.lon,
            p.lat,
            p.ele.map(|e| format!(",{e}")).unwrap_or_default()
        );
    }
    out.push_str("</coordinates></LineString>\n");
}

/// Garmin TCX (Training Center); her segment bir Track olur.
pub fn write_tcx(gpx: &Gpx) -> String {
    let mut out = String::new();
    write_tcx_into(gpx, &mut out);
    out
}

/// TCX'i bellekte tamamını tutmadan `w`'ye yazar.
pub fn write_tcx_to<W: std::io::Write>(gpx: &Gpx, w: &mut W) -> std::io::Result<()> {
    crate::write::stream(w, |s| write_tcx_into(gpx, s))
}

/// Her noktanın zamanı; zamansız noktalar öncekinden bir saniye sonrasını
/// alır, ilk zamanlı noktadan öncekiler ondan geriye doğru sayılır. Kayıtta
/// hiç zaman yoksa `fallback`ten başlanır.
fn filled_times(segs: &[&[Point]], fallback: i64) -> Vec<i64> {
    let pts = || segs.iter().flat_map(|s| s.iter());
    let lead = pts().take_while(|p| p.time.is_none()).count() as i64;
    let mut last = match pts().find_map(|p| p.time) {
        Some(t) => t - (lead + 1) * 1000,
        None => fallback - 1000,
    };
    pts()
        .map(|p| {
            last = p.time.unwrap_or(last + 1000);
            last
        })
        .collect()
}

fn write_tcx_into<S: Sink + ?Sized>(gpx: &Gpx, out: &mut S) {
    let segs = primary_segments(gpx);
    // TCX'te her noktada zaman zorunlu: eksikler doldurulur (hiç yoksa kaydın
    // zamanından ya da şimdiden başlanır).
    let fallback = gpx.time.unwrap_or_else(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64)
    });
    let filled = filled_times(&segs, fallback);
    let start = filled.first().copied().or(gpx.time);
    out.push_str(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<TrainingCenterDatabase \
         xmlns=\"http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2\" \
         xmlns:ns3=\"http://www.garmin.com/xmlschemas/ActivityExtension/v2\">\n<Activities>\n\
         <Activity Sport=\"Other\">\n",
    );
    let id = start
        .map(format_time)
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".into());
    // Tur özeti: toplam süre ve mesafe (segmentler arası atlama sayılmaz).
    // Süre yalnızca gerçek zamanlardan (doldurulanlar katılmaz).
    let times = segs.iter().flat_map(|s| s.iter()).filter_map(|p| p.time);
    let total_s = match (times.clone().min(), times.max()) {
        (Some(a), Some(b)) => (b - a) as f64 / 1000.0,
        _ => 0.0,
    };
    let total_m: f64 = segs
        .iter()
        .map(|s| {
            s.windows(2)
                .map(|w| crate::haversine_m(&w[0], &w[1]))
                .sum::<f64>()
        })
        .sum();
    let _ = writeln!(
        out,
        "<Id>{id}</Id>\n<Lap StartTime=\"{id}\">\n<TotalTimeSeconds>{total_s:.1}</TotalTimeSeconds>\n\
         <DistanceMeters>{total_m:.1}</DistanceMeters>\n<Calories>0</Calories>\n\
         <Intensity>Active</Intensity>\n<TriggerMethod>Manual</TriggerMethod>"
    );
    // Kümülatif mesafe segmentten segmente sürer.
    let mut dist = 0.0;
    let mut filled = filled.into_iter();
    for seg in segs {
        out.push_str("<Track>\n");
        for (i, p) in seg.iter().enumerate() {
            if i > 0 {
                dist += crate::haversine_m(&seg[i - 1], p);
            }
            out.push_str("<Trackpoint>");
            if let Some(t) = filled.next() {
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
}

// ---------- FIT yazma ----------

/// FIT zaman damgası Unix zamanından bu kadar saniye geridedir (1989-12-31).
const FIT_EPOCH_S: i64 = 631_065_600;

/// FIT dosyalarında kullanılan CRC-16.
fn fit_crc(data: &[u8]) -> u16 {
    const T: [u16; 16] = [
        0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800,
        0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
    ];
    let mut crc: u16 = 0;
    for &b in data {
        let mut tmp = T[(crc & 0xF) as usize];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ T[(b & 0xF) as usize];
        tmp = T[(crc & 0xF) as usize];
        crc = (crc >> 4) & 0x0FFF;
        crc = crc ^ tmp ^ T[((b >> 4) & 0xF) as usize];
    }
    crc
}

/// FIT taban türleri ve geçersiz değerleri.
#[derive(Clone, Copy)]
enum FitType {
    Enum,
    S8,
    U8,
    U16,
    S32,
    U32,
}

impl FitType {
    fn code(self) -> u8 {
        match self {
            FitType::Enum => 0x00,
            FitType::S8 => 0x01,
            FitType::U8 => 0x02,
            FitType::U16 => 0x84,
            FitType::S32 => 0x85,
            FitType::U32 => 0x86,
        }
    }
    fn size(self) -> u8 {
        match self {
            FitType::Enum | FitType::S8 | FitType::U8 => 1,
            FitType::U16 => 2,
            FitType::S32 | FitType::U32 => 4,
        }
    }
    /// Değeri yazar; `None` ya da aralık dışı değer "geçersiz" olarak yazılır.
    fn put(self, out: &mut Vec<u8>, v: Option<f64>) {
        let v = v.filter(|x| x.is_finite()).map(f64::round);
        match self {
            FitType::Enum | FitType::U8 => out.push(
                v.filter(|x| (0.0..255.0).contains(x))
                    .map_or(0xFF, |x| x as u8),
            ),
            FitType::S8 => out.push(
                v.filter(|x| (-127.0..=126.0).contains(x))
                    .map_or(0x7F, |x| x as i8 as u8),
            ),
            FitType::U16 => out.extend(
                v.filter(|x| (0.0..65535.0).contains(x))
                    .map_or(0xFFFF, |x| x as u16)
                    .to_le_bytes(),
            ),
            FitType::S32 => out.extend(
                v.filter(|x| (-2_147_483_647.0..2_147_483_647.0).contains(x))
                    .map_or(0x7FFF_FFFF, |x| x as i32)
                    .to_le_bytes(),
            ),
            FitType::U32 => out.extend(
                v.filter(|x| (0.0..4_294_967_295.0).contains(x))
                    .map_or(0xFFFF_FFFF, |x| x as u32)
                    .to_le_bytes(),
            ),
        }
    }
}

/// Bir FIT mesaj türü: yerel numara, küresel numara ve alanlar (numara, tür).
struct FitMesg {
    local: u8,
    global: u16,
    fields: &'static [(u8, FitType)],
}

impl FitMesg {
    fn define(&self, out: &mut Vec<u8>) {
        out.push(0x40 | self.local);
        out.push(0); // ayrılmış
        out.push(0); // küçük uçlu
        out.extend(self.global.to_le_bytes());
        out.push(self.fields.len() as u8);
        for &(num, t) in self.fields {
            out.extend([num, t.size(), t.code()]);
        }
    }
    fn write(&self, out: &mut Vec<u8>, values: &[Option<f64>]) {
        debug_assert_eq!(values.len(), self.fields.len());
        out.push(self.local);
        for (&(_, t), v) in self.fields.iter().zip(values) {
            t.put(out, *v);
        }
    }
}

use FitType::*;
const FIT_FILE_ID: FitMesg = FitMesg {
    local: 0,
    global: 0,
    // type, manufacturer, product, serial_number, time_created
    fields: &[(0, Enum), (1, U16), (2, U16), (3, U32), (4, U32)],
};
const FIT_EVENT: FitMesg = FitMesg {
    local: 1,
    global: 21,
    // timestamp, event, event_type
    fields: &[(253, U32), (0, Enum), (1, Enum)],
};
const FIT_RECORD: FitMesg = FitMesg {
    local: 2,
    global: 20,
    // timestamp, lat, lon, distance (cm), enhanced_altitude (5/m, +500),
    // heart_rate, cadence, power, temperature, fractional_cadence (1/128)
    fields: &[
        (253, U32),
        (0, S32),
        (1, S32),
        (5, U32),
        (78, U32),
        (3, U8),
        (4, U8),
        (7, U16),
        (13, S8),
        (53, U8),
    ],
};
const FIT_LAP: FitMesg = FitMesg {
    local: 3,
    global: 19,
    // timestamp, start_time, total_elapsed_time (ms), total_timer_time (ms),
    // total_distance (cm), event, event_type
    fields: &[
        (253, U32),
        (2, U32),
        (7, U32),
        (8, U32),
        (9, U32),
        (0, Enum),
        (1, Enum),
    ],
};
const FIT_SESSION: FitMesg = FitMesg {
    local: 4,
    global: 18,
    // timestamp, start_time, total_elapsed_time, total_timer_time,
    // total_distance, sport, sub_sport, first_lap_index, num_laps, event, event_type
    fields: &[
        (253, U32),
        (2, U32),
        (7, U32),
        (8, U32),
        (9, U32),
        (5, Enum),
        (6, Enum),
        (25, U16),
        (26, U16),
        (0, Enum),
        (1, Enum),
    ],
};
const FIT_ACTIVITY: FitMesg = FitMesg {
    local: 5,
    global: 34,
    // timestamp, total_timer_time (ms), num_sessions, type, event, event_type
    fields: &[
        (253, U32),
        (0, U32),
        (1, U16),
        (2, Enum),
        (3, Enum),
        (4, Enum),
    ],
};

/// FIT spor numarası (genel, koşu, bisiklet, yürüyüş).
fn fit_sport(activity: crate::analysis::Activity) -> u8 {
    use crate::analysis::Activity;
    match activity {
        Activity::Run => 1,
        Activity::Bike => 2,
        Activity::Walk => 11,
        Activity::Car | Activity::Unknown => 0,
    }
}

/// Bu değerden küçük FIT zaman damgaları cihaz açılışından beri geçen süre
/// sayılır (göreli); gerçek zaman olarak yazılmaz.
const FIT_MIN_TS: i64 = 0x1000_0000;
/// FIT süre alanlarının (ms, u32) en büyük geçerli değeri.
const FIT_MAX_MS: f64 = 4_294_967_294.0;

/// Kaydı FIT etkinlik dosyası olarak yazar (Garmin Connect, Strava vb.).
/// Zamanı olmayan noktalara, önceki noktadan birer saniye sonrası verilir;
/// kayıtta hiç zaman yoksa başlangıç olarak şimdiki zaman kullanılır. Her
/// segment ayrı bir tur olur; segmentler arasına zamanlayıcı durdu/başladı
/// olayları yazılır.
pub fn write_fit(gpx: &Gpx, activity: crate::analysis::Activity) -> Vec<u8> {
    let segs: Vec<&[Point]> = primary_segments(gpx)
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect();
    let gap_rule = crate::GapRule::of(&segs);
    let running = fit_sport(activity) == 1;
    // FIT'te gösterilemeyen (1998 öncesi) zamanlar yok sayılır.
    let valid = |ms: i64| ms.div_euclid(1000) - FIT_EPOCH_S >= FIT_MIN_TS;
    let now_ms = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or((FIT_EPOCH_S + FIT_MIN_TS) * 1000, |d| d.as_millis() as i64)
    };
    let first_time = segs
        .iter()
        .flat_map(|s| s.iter())
        .filter_map(|p| p.time)
        .find(|&t| valid(t))
        .or(gpx.time.filter(|&t| valid(t)))
        .unwrap_or_else(now_ms);
    // İlk zamanlı noktadan önceki zamansız noktalar ondan geriye doğru birer
    // saniye alır; yoksa sonraki gerçek zamanlar ileri kaydırılıyordu.
    let lead = segs
        .iter()
        .flat_map(|s| s.iter())
        .take_while(|p| !p.time.is_some_and(valid))
        .count();
    let has_point_time = segs
        .iter()
        .flat_map(|s| s.iter())
        .any(|p| p.time.is_some_and(valid));
    // İlk noktanın zamanı.
    let first_time = if has_point_time {
        first_time - lead as i64 * 1000
    } else {
        first_time
    };
    let fit_ts = |ms: i64| (ms.div_euclid(1000) - FIT_EPOCH_S).max(FIT_MIN_TS) as f64;

    let mut body = Vec::new();
    let start = fit_ts(first_time);
    FIT_FILE_ID.define(&mut body);
    // Tür 4: etkinlik; üretici 255: geliştirme.
    FIT_FILE_ID.write(
        &mut body,
        &[Some(4.0), Some(255.0), Some(0.0), Some(1.0), Some(start)],
    );
    FIT_EVENT.define(&mut body);
    FIT_RECORD.define(&mut body);
    FIT_LAP.define(&mut body);

    // Tur bilgisi: başlangıç, bitiş, zamanlayıcı süresi (ms), mesafe (m).
    let mut laps: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut dist = 0.0;
    // Zamansız noktalar öncekinden bir saniye sonrasını alır: ilk nokta
    // `first_time`a düşsün.
    let mut last_ms = first_time - 1000;
    let mut moving_ms: i64 = 0;
    for seg in &segs {
        let mut prev: Option<&Point> = None;
        let (mut seg_start, seg_dist0, seg_moving0) = (None, dist, moving_ms);
        for p in seg.iter() {
            let ms = p
                .time
                .filter(|&t| valid(t))
                .unwrap_or(last_ms + 1000)
                .max(last_ms);
            if seg_start.is_none() {
                seg_start = Some(fit_ts(ms));
                // Zamanlayıcı (0) başladı (0).
                FIT_EVENT.write(&mut body, &[Some(fit_ts(ms)), Some(0.0), Some(0.0)]);
            }
            // Segmentler arası bekleme ve kayıt boşlukları (uçuş, sinyal
            // kaybı) mesafeye ve zamanlayıcıya katılmaz.
            if let Some(q) = prev.filter(|q| !gap_rule.is_gap(q, p)) {
                dist += crate::stats::haversine_m(q, p);
                moving_ms += ms - last_ms;
            }
            last_ms = ms;
            prev = Some(p);
            // Koşuda FIT kadansı tek bacağın adımıdır: kayıttaki adım/dk
            // ikiye bölünür, buçuk kısmı fractional_cadence'a yazılır
            // (okurken ikiyle çarpılıyor).
            let cad = p.cad.map(|c| {
                if running {
                    let half = f64::from(c) / 2.0;
                    (half.floor(), Some((half.fract() * 128.0).round()))
                } else {
                    (f64::from(c), None)
                }
            });
            FIT_RECORD.write(
                &mut body,
                &[
                    Some(fit_ts(ms)),
                    Some(p.lat * 2_147_483_648.0 / 180.0),
                    Some(p.lon * 2_147_483_648.0 / 180.0),
                    Some(dist * 100.0),
                    p.ele.map(|e| (e as f64 + 500.0) * 5.0),
                    p.hr.map(f64::from),
                    cad.map(|c| c.0),
                    p.power.map(f64::from),
                    p.temp.map(f64::from),
                    cad.and_then(|c| c.1),
                ],
            );
        }
        let seg_end = fit_ts(last_ms);
        // Zamanlayıcı (0) durdu (4: tümü).
        FIT_EVENT.write(&mut body, &[Some(seg_end), Some(0.0), Some(4.0)]);
        laps.push((
            seg_start.unwrap_or(seg_end),
            seg_end,
            (moving_ms - seg_moving0) as f64,
            dist - seg_dist0,
        ));
    }
    let end = fit_ts(last_ms);
    if laps.is_empty() {
        FIT_EVENT.write(&mut body, &[Some(start), Some(0.0), Some(0.0)]);
        FIT_EVENT.write(&mut body, &[Some(end), Some(0.0), Some(4.0)]);
        laps.push((start, end, 0.0, 0.0));
    }
    // Çok uzun (49,7 günden uzun) kayıtlarda süre alanı taşmasın.
    let ms_field = |ms: f64| Some(ms.clamp(0.0, FIT_MAX_MS));
    for &(lap_start, lap_end, lap_timer, lap_dist) in &laps {
        // Olay 9: tur, tür 1: durdu.
        FIT_LAP.write(
            &mut body,
            &[
                Some(lap_end),
                Some(lap_start),
                ms_field((lap_end - lap_start) * 1000.0),
                ms_field(lap_timer),
                Some(lap_dist * 100.0),
                Some(9.0),
                Some(1.0),
            ],
        );
    }
    let elapsed = ms_field((end - start) * 1000.0);
    let timer = ms_field(moving_ms as f64);
    FIT_SESSION.define(&mut body);
    FIT_SESSION.write(
        &mut body,
        &[
            Some(end),
            Some(start),
            elapsed,
            timer,
            Some(dist * 100.0),
            Some(fit_sport(activity) as f64),
            Some(0.0),
            Some(0.0),
            Some(laps.len() as f64),
            Some(8.0),
            Some(1.0),
        ],
    );
    FIT_ACTIVITY.define(&mut body);
    // Tür 0: elle; olay 26: etkinlik; tür 1: durdu.
    FIT_ACTIVITY.write(
        &mut body,
        &[
            Some(end),
            timer,
            Some(1.0),
            Some(0.0),
            Some(26.0),
            Some(1.0),
        ],
    );

    let mut out = Vec::with_capacity(body.len() + 16);
    out.push(14); // başlık uzunluğu
    out.push(0x20); // protokol 2.0
    out.extend(2132u16.to_le_bytes()); // profil 21.32
    out.extend((body.len() as u32).to_le_bytes());
    out.extend(b".FIT");
    let hcrc = fit_crc(&out);
    out.extend(hcrc.to_le_bytes());
    out.extend(body);
    let crc = fit_crc(&out);
    out.extend(crc.to_le_bytes());
    out
}
