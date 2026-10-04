use super::*;
use parse::Point;
use segments::HOUR_MS;

const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Sabah Koşusu &amp; Yürüyüş</name><time>2024-05-01T06:00:00Z</time></metadata>
  <wpt lat="41.0" lon="29.0"><ele>10</ele><name>Başlangıç</name></wpt>
  <trk>
    <name>İz 1</name>
    <trkseg>
      <trkpt lat="41.0000" lon="29.0000"><ele>10</ele><time>2024-05-01T06:00:00Z</time></trkpt>
      <trkpt lat="41.0010" lon="29.0000"><ele>20</ele><time>2024-05-01T06:00:30Z</time></trkpt>
      <trkpt lat="41.0020" lon="29.0000"><ele>30</ele><time>2024-05-01T06:01:00Z</time></trkpt>
      <trkpt lat="41.0020" lon="29.0000"><ele>31</ele><time>2024-05-01T06:05:00Z</time></trkpt>
      <trkpt lat="41.0030" lon="29.0000"><ele>15</ele><time>2024-05-01T06:05:30+00:00</time></trkpt>
    </trkseg>
    <trkseg>
      <trkpt lat="41.0100" lon="29.0000"/>
      <trkpt lat="41.0110" lon="29.0000"/>
    </trkseg>
  </trk>
</gpx>"#;

#[test]
fn parses_structure() {
    let gpx = parse_gpx(SAMPLE.as_bytes()).unwrap();
    assert_eq!(gpx.name.as_deref(), Some("Sabah Koşusu & Yürüyüş"));
    assert_eq!(gpx.tracks.len(), 1);
    assert_eq!(gpx.tracks[0].name.as_deref(), Some("İz 1"));
    assert_eq!(gpx.tracks[0].segments.len(), 2);
    assert_eq!(gpx.tracks[0].segments[0].len(), 5);
    assert_eq!(gpx.tracks[0].segments[1].len(), 2);
    assert_eq!(gpx.waypoints.len(), 1);
    assert_eq!(gpx.waypoints[0].name.as_deref(), Some("Başlangıç"));
    let p = gpx.tracks[0].segments[0][1];
    assert_eq!(p.ele, Some(20.0));
    assert_eq!(p.time, Some(1714543230000));
}

#[test]
fn computes_stats() {
    let gpx = parse_gpx(SAMPLE.as_bytes()).unwrap();
    let s = summarize(&gpx, "/tmp/a.gpx", 0, &StatsConfig::default()).unwrap();
    let st = &s.stats;
    // 0.001° enlem ≈ 111.2 m; ilk segment 3 adım, ikinci 1 adım.
    assert!(
        (st.distance_m - 4.0 * 111.2).abs() < 1.0,
        "{}",
        st.distance_m
    );
    assert_eq!(st.duration_ms, Some(330_000));
    // 4 dakikalık duraklama hareket süresine girmez.
    assert_eq!(st.moving_ms, Some(90_000));
    assert_eq!(st.elevation_gain_m, Some(20.0));
    assert_eq!(st.elevation_loss_m, Some(15.0));
    assert_eq!(st.min_ele_m, Some(10.0));
    assert_eq!(st.max_ele_m, Some(31.0));
    assert_eq!(st.segment_count, 2);
    assert_eq!(s.file_name, "a.gpx");
    assert!(st.max_speed_ms.unwrap() > 3.0);
    // Harita çizgileriyle aynı düzende zaman bilgisi gelir.
    assert_eq!(s.times.len(), s.lines.len());
    for (l, t) in s.lines.iter().zip(&s.times) {
        assert_eq!(l.len(), t.len());
    }
    assert_eq!(s.times[0][0], gpx.tracks[0].segments[0][0].time);
}

#[test]
fn routes_used_when_no_tracks() {
    let xml = r#"<gpx><rte><name>R</name>
        <rtept lat="0" lon="0"/><rtept lat="0" lon="0.01"/></rte></gpx>"#;
    let gpx = parse_gpx(xml.as_bytes()).unwrap();
    let s = summarize(&gpx, "r.gpx", 0, &StatsConfig::default()).unwrap();
    assert_eq!(s.route_count, 1);
    assert_eq!(s.name.as_deref(), Some("R"));
    assert!((s.stats.distance_m - 1112.0).abs() < 1.0);
    assert_eq!(s.lines.len(), 1);
    // Zaman bilgisi olmayan dosyada boş gönderilir.
    assert!(s.times.is_empty());
}

#[test]
fn rejects_non_gpx() {
    assert!(parse_gpx(b"<kml></kml>").is_err());
    assert!(parse_gpx(b"not xml <<").is_err());
    let gpx = parse_gpx(b"<gpx></gpx>").unwrap();
    assert!(matches!(
        summarize(&gpx, "x", 0, &StatsConfig::default()),
        Err(LoadError::Empty)
    ));
}

#[test]
fn simplify_keeps_shape() {
    // Düz bir çizgi üzerindeki ara noktalar atılmalı.
    let pts: Vec<Point> = (0..1000)
        .map(|i| Point {
            lat: 0.0,
            lon: i as f64 * 1e-5,
            ..Point::default()
        })
        .collect();
    let out = simplify::douglas_peucker(&pts, 1.0);
    assert_eq!(out.len(), 2);
}

#[test]
fn detail_downsamples() {
    let mut xml = String::from("<gpx><trk><trkseg>");
    for i in 0..20_000 {
        xml.push_str(&format!(
            r#"<trkpt lat="{}" lon="29"><ele>{}</ele><time>2024-01-01T{:02}:{:02}:{:02}Z</time></trkpt>"#,
            40.0 + i as f64 * 1e-5,
            (i % 100) as f32,
            i / 3600,
            (i / 60) % 60,
            i % 60
        ));
    }
    xml.push_str("</trkseg></trk></gpx>");
    let gpx = parse_gpx(xml.as_bytes()).unwrap();
    let d = build_detail(&gpx);
    // Seyreltilmiş örneklere 6 saatin her birinin ilk noktası eklenir.
    assert!((PROFILE_MAX_POINTS..=PROFILE_MAX_POINTS + 6).contains(&d.dist.len()));
    assert!(d.dist.windows(2).all(|w| w[0] <= w[1]));
    assert!(d.speed.iter().any(|s| s.is_some()));
}

#[test]
fn fingerprint_ignores_formatting_and_names() {
    let a = r#"<gpx><metadata><name>A</name></metadata><trk><trkseg>
        <trkpt lat="41.0" lon="29.0"><time>2024-05-01T06:00:00Z</time></trkpt>
        <trkpt lat="41.001" lon="29.0"><time>2024-05-01T06:00:30Z</time></trkpt>
        </trkseg></trk></gpx>"#;
    let b = r#"<?xml version="1.0"?><gpx creator="x"><trk><name>B</name><trkseg>
        <trkpt lon="29.000000" lat="41.000000"><ele>5</ele><time>2024-05-01T06:00:00Z</time></trkpt>
        <trkpt lon="29.000000" lat="41.001000"><time>2024-05-01T06:00:30Z</time></trkpt>
        </trkseg></trk></gpx>"#;
    let c = a.replace("06:00:30", "06:00:31");
    let fa = fingerprint(&parse_gpx(a.as_bytes()).unwrap());
    let fb = fingerprint(&parse_gpx(b.as_bytes()).unwrap());
    let fc = fingerprint(&parse_gpx(c.as_bytes()).unwrap());
    assert_eq!(fa, fb);
    assert_ne!(fa, fc);
}

const SENSORS: &str = r#"<gpx xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<trk><trkseg>
<trkpt lat="41" lon="29"><ele>10</ele><time>2024-05-01T06:00:00Z</time>
  <extensions><power>200</power><gpxtpx:TrackPointExtension><gpxtpx:atemp>21.5</gpxtpx:atemp><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>80</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="41.001" lon="29"><ele>12</ele><time>2024-05-01T06:00:30Z</time>
  <extensions><power>300</power><gpxtpx:TrackPointExtension><gpxtpx:hr>140</gpxtpx:hr><gpxtpx:cad>90</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
<trkpt lat="41.002" lon="29"><ele>14</ele><time>2024-05-01T06:01:00Z</time></trkpt>
</trkseg></trk></gpx>"#;

#[test]
fn parses_sensor_extensions() {
    let gpx = parse_gpx(SENSORS.as_bytes()).unwrap();
    let p = gpx.tracks[0].segments[0][0];
    assert_eq!(
        (p.hr, p.cad, p.power, p.temp),
        (Some(120.0), Some(80.0), Some(200.0), Some(21.5))
    );
    let s = summarize(&gpx, "s.gpx", 0, &StatsConfig::default())
        .unwrap()
        .stats;
    assert_eq!(s.avg_hr, Some(130.0));
    assert_eq!(s.max_hr, Some(140.0));
    assert_eq!(s.avg_power, Some(250.0));
    let d = build_detail(&gpx);
    assert_eq!(d.hr, vec![Some(120.0), Some(140.0), None]);
    assert_eq!(d.idx, vec![0, 1, 2]);
    // Sensörsüz dosyada diziler boş gelir.
    assert!(build_detail(&parse_gpx(SAMPLE.as_bytes()).unwrap())
        .hr
        .is_empty());
}

#[test]
fn thresholds_are_configurable() {
    let gpx = parse_gpx(SAMPLE.as_bytes()).unwrap();
    let strict = StatsConfig {
        moving_speed_ms: 5.0,
        elevation_threshold_m: 50.0,
        ..StatsConfig::default()
    };
    let s = summarize(&gpx, "a", 0, &strict).unwrap().stats;
    // 111 m / 30 sn ≈ 3,7 m/s < 5 m/s: hiç hareket yok sayılır.
    assert_eq!(s.moving_ms, Some(0));
    assert_eq!(s.elevation_gain_m, Some(0.0));
}

#[test]
fn range_stats_and_ops() {
    let gpx = parse_gpx(SAMPLE.as_bytes()).unwrap();
    // 7 nokta: ilk segment 0..=4, ikinci 5..=6.
    let r = range_stats(&gpx, 1, 3, &StatsConfig::default());
    assert_eq!(r.point_count, 3);
    assert!((r.distance_m - 111.2).abs() < 1.0);
    let r = range_stats(&gpx, 4, 5, &StatsConfig::default());
    assert_eq!(r.segment_count, 2);
    assert_eq!(r.distance_m, 0.0);

    let t = ops::trim(&gpx, 1, 3).unwrap();
    assert_eq!(
        primary_segments(&t).iter().map(|s| s.len()).sum::<usize>(),
        3
    );
    assert!(t.name.unwrap().contains("kırpılmış"));
    // İşaret noktası ilk noktaya en yakın; kırpılan aralıkta değil.
    assert!(t.waypoints.is_empty());

    let (a, b) = ops::split(&gpx, 2).unwrap();
    assert_eq!(
        primary_segments(&a).iter().map(|s| s.len()).sum::<usize>(),
        3
    );
    assert_eq!(
        primary_segments(&b).iter().map(|s| s.len()).sum::<usize>(),
        5
    );
    assert_eq!(a.waypoints.len(), 1);
    assert!(ops::split(&gpx, 0).is_none());

    let m = ops::merge(vec![b, a], Some("Birleşik".into()));
    assert_eq!(m.tracks.len(), 2);
    // Başlangıç zamanına göre sıralanır.
    assert!(m.tracks[0].name.as_deref().unwrap().contains("1. kısım"));
}

#[test]
fn writer_round_trips() {
    for src in [SAMPLE, SENSORS] {
        let gpx = parse_gpx(src.as_bytes()).unwrap();
        let text = write::write_gpx(&gpx);
        let back = parse_gpx(text.as_bytes()).unwrap();
        assert_eq!(fingerprint(&gpx), fingerprint(&back));
        assert_eq!(back.name, gpx.name);
        assert_eq!(back.waypoints.len(), gpx.waypoints.len());
        let pts = |g: &parse::Gpx| {
            primary_segments(g)
                .iter()
                .flat_map(|s| s.to_vec())
                .collect::<Vec<_>>()
        };
        assert_eq!(pts(&back), pts(&gpx));
    }
}

fn pt(lat: f64, lon: f64, t: i64) -> Point {
    Point {
        lat,
        lon,
        time: Some(t * 1000),
        ..Point::default()
    }
}

#[test]
fn removes_gps_spikes() {
    // 5 m/s ile kuzeye giden iz; ortadaki nokta 500 m doğuya sıçramış.
    let mut seg: Vec<Point> = (0..10)
        .map(|i| pt(41.0 + i as f64 * 4.5e-5, 29.0, i))
        .collect();
    seg[5].lon += 0.006;
    // Bir de akla yatkın olmayan tek sıçrama (yaklaşık 50 km, 1 sn).
    seg.push(pt(41.5, 29.0, 10));
    seg.push(pt(41.0 + 11.0 * 4.5e-5, 29.0, 11));
    let removed = analysis::clean_segment(&mut seg);
    assert_eq!(removed, 2);
    assert!(seg
        .iter()
        .all(|p| (p.lon - 29.0).abs() < 1e-9 && p.lat < 41.1));
    // Düzgün bir viraj silinmez.
    let mut turn: Vec<Point> = (0..10)
        .map(|i| pt(41.0, 29.0 + i as f64 * 6e-5, i))
        .collect();
    turn.extend((1..10).map(|i| pt(41.0 + i as f64 * 4.5e-5, 29.0 + 9.0 * 6e-5, 9 + i)));
    assert_eq!(analysis::clean_segment(&mut turn), 0);
}

#[test]
fn removes_multi_point_jumps_and_bad_edges() {
    // 1,4 m/s ile yürüyüş (doğuya).
    let walk = |i: i64| pt(41.0, 29.0 + i as f64 * 1.67e-5, i);
    // Ortada 3 nokta 400 m kuzeye kaymış.
    let mut seg: Vec<Point> = (0..60).map(walk).collect();
    for p in &mut seg[30..33] {
        p.lat += 0.0036;
    }
    // Başta uydu kilitlenmeden alınmış 2 nokta (2 km uzakta).
    seg[0].lat += 0.018;
    seg[1].lat += 0.018;
    seg[1].lon += 0.001;
    // Sonda kopuk 1 nokta.
    seg.push(pt(41.02, 29.02, 60));
    let removed = analysis::clean_segment(&mut seg);
    assert_eq!(removed, 6);
    assert!(seg.iter().all(|p| (p.lat - 41.0).abs() < 1e-9));

    // Yürüyüş içinde gerçek tren yolculuğu (30 m/s, 5 dk) ve tünelde 2 dk
    // sinyal kaybı silinmez.
    let mut trip: Vec<Point> = (0..60).map(walk).collect();
    let lon0 = trip.last().unwrap().lon;
    trip.extend((1..=300).map(|k| pt(41.0, lon0 + k as f64 * 3.58e-4, 59 + k)));
    let lon1 = trip.last().unwrap().lon;
    trip.push(pt(41.0, lon1 + 0.012, 359 + 120));
    trip.extend((1..30).map(|k| pt(41.0, lon1 + 0.012 + k as f64 * 1.67e-5, 479 + k)));
    let n = trip.len();
    assert_eq!(analysis::clean_segment(&mut trip), 0);
    assert_eq!(trip.len(), n);
}

#[test]
fn keeps_flights_and_bunched_updates() {
    // Yürüyüş, ardından segmentin ortasında 220 m/s uçuş, sonra yine yürüyüş.
    let mut seg: Vec<Point> = (0..30)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1.67e-5, i))
        .collect();
    let lon0 = seg.last().unwrap().lon;
    seg.extend((1..=200).map(|k| pt(41.0 + k as f64 * 1.98e-3, lon0, 29 + k)));
    let lat1 = seg.last().unwrap().lat;
    seg.extend((1..30).map(|k| pt(lat1, lon0 + k as f64 * 1.67e-5, 229 + k)));
    let n = seg.len();
    assert_eq!(analysis::clean_segment(&mut seg), 0);
    assert_eq!(seg.len(), n);

    // Telefonun konumu kümeler hâlinde güncellemesi: aynı konum, sonra 110 m ileri.
    let mut bunched: Vec<Point> = (0..40)
        .map(|i| pt(41.0, 29.0 + (i / 3) as f64 * 1.3e-3, i))
        .collect();
    assert_eq!(analysis::clean_segment(&mut bunched), 0);

    // Segmentin başında eski konum (2000 km uzakta, 1 sn önce) atılır.
    let mut stale: Vec<Point> = vec![pt(50.88, 7.12, 0)];
    stale.extend((1..30).map(|i| pt(40.88, 29.27 + i as f64 * 1e-4, i)));
    assert_eq!(analysis::clean_segment(&mut stale), 1);
    assert!(stale[0].lat < 41.0);
}

#[test]
fn detects_stops_and_activity() {
    // 3,5 m/s (12,6 km/sa).
    let mut seg: Vec<Point> = (0..60)
        .map(|i| pt(41.0 + i as f64 * 3.15e-5, 29.0, i))
        .collect();
    // 5 dakika aynı yerde (küçük titremelerle).
    let last = seg.last().unwrap().lat;
    for k in 1..=30 {
        seg.push(pt(
            last + if k % 2 == 0 { 2e-5 } else { 0.0 },
            29.0,
            59 + k * 10,
        ));
    }
    let t = 59 + 300;
    seg.extend((1..60).map(|i| pt(last + i as f64 * 3.15e-5, 29.0, t + i)));
    let stops = analysis::detect_stops([seg.as_slice()]);
    assert_eq!(stops.len(), 1);
    assert!(stops[0].duration_ms >= 290_000);

    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    // ~12,6 km/sa: koşu.
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert_eq!(s.activity, Activity::Run);
    assert_eq!(s.stops.len(), 1);
    let s = summarize_with(
        &gpx,
        "a.gpx",
        0,
        &StatsConfig::default(),
        Some(Activity::Bike),
    )
    .unwrap();
    assert_eq!(s.activity, Activity::Bike);
    assert!(s.activity_set);
    // Türe göre eşik: araçta 6 km/sa altı durma sayılır.
    let cfg = StatsConfig {
        per_type: true,
        ..StatsConfig::default()
    };
    let (eff, _) = effective_config(&gpx, &cfg, Some(Activity::Car));
    assert!((eff.moving_speed_ms - 6.0 / 3.6).abs() < 1e-9);
}

#[test]
fn reads_fit() {
    let bytes = include_bytes!("../testdata/garmin-fenix-5-bike.fit");
    let gpx = formats::parse_any("FIT", bytes).unwrap();
    let pts: Vec<_> = primary_segments(&gpx)
        .iter()
        .flat_map(|s| s.to_vec())
        .collect();
    assert!(pts.len() > 10, "{}", pts.len());
    assert!(pts
        .iter()
        .all(|p| p.lat.abs() <= 90.0 && p.lon.abs() <= 180.0));
    assert!(pts.iter().any(|p| p.time.is_some()));
    let s = summarize(&gpx, "x.fit", 0, &StatsConfig::default()).unwrap();
    assert!(
        s.stats.distance_m > 10.0,
        "{} m, {} nokta",
        s.stats.distance_m,
        pts.len()
    );
}

#[test]
fn tcx_and_kml_round_trip() {
    let gpx = parse_gpx(SENSORS.as_bytes()).unwrap();
    let pts = |g: &parse::Gpx| {
        primary_segments(g)
            .iter()
            .flat_map(|s| s.to_vec())
            .collect::<Vec<_>>()
    };
    let tcx = formats::parse_tcx(formats::write_tcx(&gpx).as_bytes()).unwrap();
    let (a, b) = (pts(&gpx), pts(&tcx));
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(&b) {
        assert_eq!(
            (x.lat, x.lon, x.ele, x.time, x.hr, x.cad, x.power),
            (y.lat, y.lon, y.ele, y.time, y.hr, y.cad, y.power)
        );
    }
    let kml = formats::parse_kml(formats::write_kml(&gpx).as_bytes()).unwrap();
    let k = pts(&kml);
    assert_eq!(k.len(), a.len());
    for (x, y) in a.iter().zip(&k) {
        assert_eq!((x.lat, x.lon, x.time), (y.lat, y.lon, y.time));
    }
    // Zamansız KML LineString ve işaret noktası.
    let simple = r#"<kml><Document><name>D</name><Placemark><name>P</name><Point><coordinates>29,41,5</coordinates></Point></Placemark>
        <Placemark><name>Yol</name><LineString><coordinates>29,41 29.01,41.01</coordinates></LineString></Placemark></Document></kml>"#;
    let g = formats::parse_kml(simple.as_bytes()).unwrap();
    assert_eq!(g.waypoints.len(), 1);
    assert_eq!(g.waypoints[0].name.as_deref(), Some("P"));
    assert_eq!(pts(&g).len(), 2);
    assert!(formats::parse_kml(b"<gpx/>").is_err());
}

#[test]
fn splits_lines_at_recording_gaps() {
    // Yürüyüş, 2 saat 1700 km boşluk (uçuş), yine yürüyüş.
    let mut seg: Vec<Point> = (0..20)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1.67e-5, i))
        .collect();
    seg.extend((0..20).map(|i| pt(50.2, 12.2 + i as f64 * 2.6e-5, 7500 + i)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert_eq!(s.lines.len(), 2);
    assert_eq!(s.times.len(), 2);
    assert_eq!(s.gaps.len(), 1);
    let g = &s.gaps[0];
    assert!(g.distance_m > 1_000_000.0);
    assert_eq!(g.end.unwrap() - g.start.unwrap(), 7481 * 1000);
}

#[test]
fn collapses_long_stays() {
    // Yürüyüş, 1 saat aynı yerde titreme (±100 m, arada 300 m sıçramalar), yürüyüş.
    let mut seg: Vec<Point> = (0..60)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1.67e-5, i))
        .collect();
    let (lat0, lon0) = (41.0, seg.last().unwrap().lon);
    let mut t = 60;
    for k in 0..360 {
        let a = k as f64 * 2.4;
        let r = if k % 37 == 0 {
            2.7e-3
        } else {
            8e-4 * ((k * 7 % 10) as f64 / 10.0)
        };
        seg.push(pt(lat0 + r * a.sin(), lon0 + r * a.cos(), t));
        t += 10;
    }
    seg.extend((1..60).map(|i| pt(41.0, lon0 + i as f64 * 1.67e-5, t + i)));
    let n = seg.len();
    let removed = analysis::collapse_segment_stays(&mut seg);
    assert!(removed > 350, "removed {removed} of {n}");
    // Duraklama iki noktaya indi ve süresi korundu.
    let stops = analysis::detect_stops([seg.as_slice()]);
    assert_eq!(stops.len(), 1);
    assert!(stops[0].duration_ms > 55 * 60 * 1000);

    // Sürekli yürüyüş dokunulmaz.
    let mut walk: Vec<Point> = (0..600)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1.67e-5, i))
        .collect();
    assert_eq!(analysis::collapse_segment_stays(&mut walk), 0);
}

/// Yürüyüş, 2 saat 1700 km boşluk (uçuş), yine yürüyüş.
fn gap_gpx() -> parse::Gpx {
    let mut seg: Vec<Point> = (0..20)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1.67e-5, i))
        .collect();
    seg.extend((0..20).map(|i| pt(50.2, 12.2 + i as f64 * 2.6e-5, 7500 + i)));
    parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    }
}

#[test]
fn gaps_are_not_counted() {
    let gpx = gap_gpx();
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    let st = &s.stats;
    // Yalnızca iki yürüyüş: 19 + 19 adım, ~1,4 + ~1,85 m.
    assert!(st.distance_m < 70.0, "{}", st.distance_m);
    assert!(st.max_speed_ms.unwrap() < 3.0, "{:?}", st.max_speed_ms);
    assert!(st.avg_moving_speed_ms.unwrap() < 3.0);
    assert_eq!(st.segment_count, 1);
    assert_eq!(st.point_count, 40);
    // Aralık istatistiği ve grafik de boşluğu atlar.
    let r = range_stats(&gpx, 0, 39, &StatsConfig::default());
    assert!((r.distance_m - st.distance_m).abs() < 1e-6);
    let d = build_detail(&gpx);
    assert!((d.dist.last().unwrap() - st.distance_m).abs() < 1e-6);
    assert!(d.speed.iter().flatten().all(|v| *v < 10.0), "{:?}", d.speed);
    assert_eq!(d.idx, (0..40).collect::<Vec<u32>>());
}

#[test]
fn detail_marks_gaps_between_samples() {
    // Seyreltilmemiş: boşluk 19. ile 20. örnek arasında.
    let d = build_detail(&gap_gpx());
    assert_eq!(d.gap_after, vec![19]);

    // Seyreltilmiş uzun kayıt: boşluğun uçları örneklere denk gelmese de
    // tek bir kesik, boşluğu kapsayan örnek çiftinde işaretlenir; örnekler
    // arası uzun ama boşluksuz adımlar işaretlenmez.
    let mut seg: Vec<Point> = (0..10_000)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1e-5, i))
        .collect();
    seg.extend((0..10_000).map(|i| pt(50.2, 12.2 + i as f64 * 1e-5, 20_000 + i)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let d = build_detail(&gpx);
    assert!((PROFILE_MAX_POINTS..=PROFILE_MAX_POINTS + 9).contains(&d.idx.len()));
    assert_eq!(d.gap_after.len(), 1);
    let k = d.gap_after[0] as usize;
    assert!(d.idx[k] < 10_000 && d.idx[k + 1] >= 10_000);

    // Boşluksuz kayıtta kesik yok.
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![(0..50)
                .map(|i| pt(41.0, 29.0 + i as f64 * 1e-5, i))
                .collect()],
        }],
        ..Default::default()
    };
    assert!(build_detail(&gpx).gap_after.is_empty());
}

#[test]
fn detail_speed_handles_equal_and_backward_times() {
    // Hepsi aynı zamanlı 60 000 nokta: pencere doğrusal kalmalı.
    let seg: Vec<Point> = (0..60_000)
        .map(|i| pt(41.0 + (i % 7) as f64 * 1e-6, 29.0, 100))
        .collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg.clone()],
        }],
        ..Default::default()
    };
    let t = std::time::Instant::now();
    let d = build_detail(&gpx);
    assert!(d.speed.iter().all(|s| s.is_none()));
    // Geriye giden zamanlar.
    let back: Vec<Point> = (0..60_000)
        .map(|i| pt(41.0 + i as f64 * 1e-6, 29.0, 100_000 - i))
        .collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![back],
        }],
        ..Default::default()
    };
    build_detail(&gpx);
    assert!(analysis::detect_stops([seg.as_slice()]).is_empty());
    assert!(t.elapsed().as_secs() < 5, "{:?}", t.elapsed());
}

/// 400 m'lik atletizm pistinde (84,39 m düzlük, 36,5 m viraj yarıçapı) `s`
/// metredeki nokta.
fn track_point(s: f64, t: i64) -> Point {
    let (straight, r) = (84.39, 36.5);
    let arc = std::f64::consts::PI * r;
    let len = 2.0 * straight + 2.0 * arc;
    let s = s % len;
    let (x, y) = if s < straight {
        (s, 0.0)
    } else if s < straight + arc {
        let a = (s - straight) / r;
        (straight + r * a.sin(), r - r * a.cos())
    } else if s < 2.0 * straight + arc {
        (straight - (s - straight - arc), 2.0 * r)
    } else {
        let a = (s - 2.0 * straight - arc) / r;
        (-r * a.sin(), r + r * a.cos())
    };
    pt(
        41.0 + y / 111_195.0,
        29.0 + x / (111_195.0 * 41f64.to_radians().cos()),
        t,
    )
}

#[test]
fn keeps_running_on_a_track() {
    // 30 dakika 3,3 m/s ile pistte koşu (1 sn aralıkla, ±2 m gürültü).
    let mut seg: Vec<Point> = (0..1800)
        .map(|i| {
            let mut p = track_point(i as f64 * 3.3, i);
            p.lat += ((i * 37 % 11) as f64 - 5.0) * 4e-6;
            p
        })
        .collect();
    let n = seg.len();
    assert_eq!(analysis::collapse_segment_stays(&mut seg), 0);
    assert_eq!(seg.len(), n);
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let p = prepare(gpx, &StatsConfig::default());
    assert_eq!((p.removed, p.collapsed), (0, 0));
    let s = summarize(&p.gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert!(s.stats.distance_m > 5800.0, "{}", s.stats.distance_m);

    // Akıllı kayıtla (5 sn) aynı koşu da korunur.
    let mut sparse: Vec<Point> = (0..360)
        .map(|i| track_point(i as f64 * 16.5, i * 5))
        .collect();
    assert_eq!(analysis::collapse_segment_stays(&mut sparse), 0);
}

#[test]
fn prepared_maps_back_to_raw_points() {
    // Kuzeye yürüyüş; 5. nokta sıçrama, ardından 1 saat titreme, yine yürüyüş.
    let mut seg: Vec<Point> = (0..60)
        .map(|i| pt(41.0 + i as f64 * 4.5e-5, 29.0, i))
        .collect();
    seg[5].lon += 0.006;
    let (lat0, mut t) = (seg.last().unwrap().lat, 60);
    for k in 0..360 {
        let a = k as f64 * 2.4;
        let r = 8e-4 * ((k * 7 % 10) as f64 / 10.0);
        seg.push(pt(lat0 + r * a.sin(), 29.0 + r * a.cos(), t));
        t += 10;
    }
    seg.extend((1..20).map(|i| pt(lat0 + i as f64 * 4.5e-5, 29.0, t + i)));
    let raw = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![vec![pt(40.0, 28.0, 0), pt(40.0, 28.0001, 1)], seg.clone()],
        }],
        ..Default::default()
    };
    let p = prepare(raw.clone(), &StatsConfig::default());
    assert_eq!(p.removed, 1);
    assert!(p.collapsed > 300, "{}", p.collapsed);
    let raw_pts: Vec<Point> = primary_segments(&raw)
        .iter()
        .flat_map(|s| s.to_vec())
        .collect();
    let prep_pts: Vec<Point> = primary_segments(&p.gpx)
        .iter()
        .flat_map(|s| s.to_vec())
        .collect();
    assert_eq!(p.len(), prep_pts.len());
    for (i, q) in prep_pts.iter().enumerate() {
        let r = raw_pts[p.raw_index(i).unwrap()];
        // Zamanlar aynı; konum yalnızca duraklamanın iki noktasında farklı.
        assert_eq!(q.time, r.time);
    }
    assert_eq!(p.raw_index(1), Some(1));
    assert_eq!(p.raw_index(2), Some(2));
    // Sıçrama (ham 2 + 5) atlanır.
    assert_eq!(p.raw_index(2 + 5), Some(2 + 6));
    assert_eq!(p.raw_index(p.len()), None);
    // Ham kayıt eşlenen sırayla kırpılır: duraklama tümüyle korunur.
    let end = p.raw_index(p.len() - 1).unwrap();
    let t = ops::trim(&raw, p.raw_index(2).unwrap(), end).unwrap();
    assert_eq!(
        primary_segments(&t).iter().map(|s| s.len()).sum::<usize>(),
        seg.len()
    );
    // Sınırda taşma olmaz.
    assert!(ops::slice_segments(&primary_segments(&raw), 0, usize::MAX).len() == 2);
}

#[test]
fn kml_and_tcx_edge_cases() {
    // Geçersiz koordinatlar atılır; bozuk gx:coord sonraki zamanları kaydırmaz;
    // iz adı izin Placemark'ından gelir.
    let kml = r#"<kml><Document>
        <Placemark><name>Gezi</name><gx:Track>
          <when>2024-05-01T06:00:00Z</when><when>2024-05-01T06:00:10Z</when><when>2024-05-01T06:00:20Z</when>
          <gx:coord>29 41 5</gx:coord><gx:coord>NaN 41 5</gx:coord><gx:coord>29.001 41 inf</gx:coord>
        </gx:Track></Placemark>
        <Placemark><name>Nokta</name><Point><coordinates>29,41</coordinates></Point></Placemark>
        <Placemark><name>Kötü</name><Point><coordinates>nan,41</coordinates></Point></Placemark>
        </Document></kml>"#;
    let g = formats::parse_kml(kml.as_bytes()).unwrap();
    assert_eq!(g.tracks[0].name.as_deref(), Some("Gezi"));
    let seg = &g.tracks[0].segments[0];
    assert_eq!(seg.len(), 1);
    assert_eq!(seg[0].time, Some(1714543200000));
    assert_eq!(g.waypoints.len(), 1);
    let kml = kml.replace("29.001 41 inf", "29.001 41 7");
    let g = formats::parse_kml(kml.as_bytes()).unwrap();
    let seg = &g.tracks[0].segments[0];
    assert_eq!(seg.len(), 2);
    assert_eq!(seg[1].time, Some(1714543220000));

    // Yüksekliği olmayan nokta KML'de 0 m yazılmaz.
    let mut gpx = parse_gpx(SAMPLE.as_bytes()).unwrap();
    gpx.tracks[0].segments[0][1].ele = None;
    let text = formats::write_kml(&gpx);
    assert!(
        !text.contains(" 0</gx:coord>") && !text.contains(",0\n"),
        "{text}"
    );
    let back = formats::parse_kml(text.as_bytes()).unwrap();
    assert_eq!(back.tracks[0].segments[0][1].ele, None);
    assert_eq!(back.tracks[0].segments[0][0].ele, Some(10.0));

    // TCX: mesafe segmentler boyunca sürer; turda süre ve mesafe var.
    let tcx = formats::write_tcx(&parse_gpx(SAMPLE.as_bytes()).unwrap());
    assert!(
        tcx.contains("<TotalTimeSeconds>330.0</TotalTimeSeconds>"),
        "{tcx}"
    );
    let lap_m: f64 = tcx
        .split("<DistanceMeters>")
        .nth(1)
        .and_then(|s| s.split('<').next())
        .and_then(|s| s.parse().ok())
        .unwrap();
    let last_m: f64 = tcx
        .rsplit("<DistanceMeters>")
        .next()
        .and_then(|s| s.split('<').next())
        .and_then(|s| s.parse().ok())
        .unwrap();
    assert!((lap_m - 4.0 * 111.2).abs() < 1.0, "{lap_m}");
    assert!((last_m - lap_m).abs() < 0.2, "{last_m} {lap_m}");
    let bad = tcx.replacen("<LatitudeDegrees>41", "<LatitudeDegrees>NaN", 1);
    let g = formats::parse_tcx(bad.as_bytes()).unwrap();
    assert_eq!(
        primary_segments(&g).iter().map(|s| s.len()).sum::<usize>(),
        6
    );
}

#[test]
fn fit_round_trip() {
    let src = std::fs::read("testdata/garmin-fenix-5-bike.fit").unwrap();
    let gpx = formats::parse_fit(&src).unwrap();
    let bytes = formats::write_fit(&gpx, Activity::Bike);
    // Başlık ve CRC doğru, okuyucu (fitparser) kabul ediyor.
    let back = formats::parse_fit(&bytes).unwrap();
    let pts = |g: &parse::Gpx| -> Vec<Point> {
        g.tracks
            .iter()
            .flat_map(|t| t.segments.iter().flatten())
            .copied()
            .collect()
    };
    let (a, b) = (pts(&gpx), pts(&back));
    assert_eq!(a.len(), b.len());
    for (p, q) in a.iter().zip(&b) {
        assert!((p.lat - q.lat).abs() < 1e-6 && (p.lon - q.lon).abs() < 1e-6);
        assert_eq!(p.time.map(|t| t / 1000), q.time.map(|t| t / 1000));
        assert_eq!(p.hr, q.hr);
        match (p.ele, q.ele) {
            (Some(x), Some(y)) => assert!((x - y).abs() < 0.3),
            (x, y) => assert_eq!(x.is_some(), y.is_some()),
        }
    }
}

/// Yazılan FIT dosyasındaki `kind` mesajlarının `field` alanları.
fn fit_fields(bytes: &[u8], kind: fitparser::profile::MesgNum, field: &str) -> Vec<String> {
    fitparser::from_bytes(bytes)
        .unwrap()
        .iter()
        .filter(|r| r.kind() == kind)
        .filter_map(|r| {
            r.fields()
                .iter()
                .find(|f| f.name() == field)
                .map(|f| f.value().to_string())
        })
        .collect()
}

fn fpt(lat: f64, lon: f64, time: Option<i64>) -> Point {
    Point {
        lat,
        lon,
        time,
        ..Default::default()
    }
}

#[test]
fn fit_keeps_segments() {
    let t0 = 1_700_000_000_000;
    let seg = |lat: f64, t: i64| -> Vec<Point> {
        (0..5)
            .map(|i| fpt(lat + i as f64 * 0.0001, 29.0, Some(t + i * 1000)))
            .collect()
    };
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg(41.0, t0), seg(41.001, t0 + 600_000)],
        }],
        ..Default::default()
    };
    let bytes = formats::write_fit(&gpx, Activity::Walk);
    use fitparser::profile::MesgNum;
    // Her segment ayrı tur; arada zamanlayıcı durdu/başladı.
    assert_eq!(fit_fields(&bytes, MesgNum::Lap, "start_time").len(), 2);
    assert_eq!(
        fit_fields(&bytes, MesgNum::Session, "num_laps"),
        vec!["2".to_owned()]
    );
    assert_eq!(
        fit_fields(&bytes, MesgNum::Event, "event_type"),
        ["start", "stop_all", "start", "stop_all"]
    );
    let back = formats::parse_fit(&bytes).unwrap();
    let lens: Vec<usize> = back.tracks[0].segments.iter().map(Vec::len).collect();
    assert_eq!(lens, vec![5, 5]);
    assert_eq!(back.tracks[0].segments[1][0].time, Some(t0 + 600_000));
}

#[test]
fn fit_without_times_uses_now() {
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![vec![fpt(41.0, 29.0, None), fpt(41.0001, 29.0, None)]],
        }],
        ..Default::default()
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let back = formats::parse_fit(&formats::write_fit(&gpx, Activity::Walk)).unwrap();
    let times: Vec<i64> = back.tracks[0].segments[0]
        .iter()
        .map(|p| p.time.unwrap())
        .collect();
    assert!((times[0] - now).abs() < 5_000, "{} {now}", times[0]);
    assert_eq!(times[1] - times[0], 1000);
}

#[test]
fn fit_clamps_long_durations() {
    // 60 gün süren, kopukluğu olmayan bir kayıt (49,7 günü aşar).
    let t0 = 1_700_000_000_000;
    let day = 86_400_000;
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![vec![
                fpt(41.0, 29.0, Some(t0)),
                fpt(41.0, 29.0, Some(t0 + 60 * day)),
            ]],
        }],
        ..Default::default()
    };
    let bytes = formats::write_fit(&gpx, Activity::Walk);
    use fitparser::profile::MesgNum;
    for field in ["total_elapsed_time", "total_timer_time"] {
        let v = fit_fields(&bytes, MesgNum::Session, field);
        assert_eq!(v.len(), 1, "{field}");
        let secs: f64 = v[0].parse().unwrap();
        assert!((secs - 4_294_967.294).abs() < 0.01, "{field} {secs}");
    }
}

#[test]
fn hourly_buckets_match_totals() {
    // 3 saat süren yürüyüş, arada 1678 km'lik bir uçuş boşluğu.
    let mut seg: Vec<Point> = (0..5400)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1.67e-5, i * 2))
        .collect();
    seg.extend((0..600).map(|i| pt(50.2, 12.2 + i as f64 * 1.67e-5, 20_000 + i * 2)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert!(s.hours.len() >= 4, "{:?}", s.hours.len());
    let d: f64 = s.hours.iter().map(|h| h[1]).sum();
    let m: f64 = s.hours.iter().map(|h| h[2]).sum();
    assert!(
        (d - s.stats.distance_m).abs() < 1.0,
        "{d} vs {}",
        s.stats.distance_m
    );
    assert_eq!(m as i64, s.stats.moving_ms.unwrap_or(0));
    assert!(s.hours.windows(2).all(|w| w[0][0] < w[1][0]));
}

#[test]
fn hour_first_points_follow_hours() {
    // Saat başından 30 dk önce başlayan, 2,5 saat süren kayıt.
    let seg: Vec<Point> = (0..9000)
        .map(|i| pt(41.0 + i as f64 * 1e-5, 29.0, 1800 + i))
        .collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert!(s.visits.is_empty());
    let firsts = hour_first_points(&gpx, &s.hours);
    assert_eq!(firsts.len(), s.hours.len());
    assert_eq!(firsts.len(), 3);
    assert_eq!(firsts[0], (0, [29.0, 41.0]));
    // İkinci saatin ilk noktası 3600. saniyedeki nokta.
    assert_eq!(firsts[1].0, HOUR_MS);
    assert!((firsts[1].1[1] - (41.0 + 1800.0 * 1e-5)).abs() < 1e-9);
    // Listede olmayan saat atlanır.
    assert!(hour_first_points(&gpx, &[[5.0 * HOUR_MS as f64, 0.0, 0.0]]).is_empty());
}

#[test]
fn hourly_buckets_include_last_point_hour() {
    // Son noktası tek başına bir sonraki saate düşen segment; ardından
    // boşluktan sonra yalnızca son noktası yeni saatte olan ikinci parça.
    let seg = vec![
        pt(41.0, 29.0, 3000),
        pt(41.0, 29.001, 3500),
        pt(41.0, 29.002, 3700),
    ];
    let seg2 = vec![
        pt(41.5, 29.5, 3 * 3600 + 3000),
        pt(41.5, 29.501, 4 * 3600 + 10),
    ];
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg, seg2],
        }],
        ..Default::default()
    };
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    let hours: Vec<i64> = s.hours.iter().map(|h| h[0] as i64).collect();
    assert_eq!(
        hours,
        [0, HOUR_MS, 3 * HOUR_MS, 4 * HOUR_MS],
        "{:?}",
        s.hours
    );
    // Yalnızca son noktanın düştüğü saatlerin mesafesi 0.
    assert_eq!(s.hours[1][1], 0.0);
    assert_eq!(s.hours[3][1], 0.0);
    let firsts = hour_first_points(&gpx, &s.hours);
    assert_eq!(firsts.len(), 4);
    assert_eq!(firsts[1], (HOUR_MS, [29.002, 41.0]));
}

#[test]
fn streaming_writers_match_string_writers() {
    let gpx = parse::Gpx {
        name: Some("A & B".into()),
        tracks: vec![parse::Track {
            name: Some("iz".into()),
            segments: vec![vec![pt(41.0, 29.0, 0), pt(41.001, 29.0, 60)]],
        }],
        ..Default::default()
    };
    let mut buf = Vec::new();
    write::write_gpx_to(&gpx, &mut buf).unwrap();
    assert_eq!(String::from_utf8(buf).unwrap(), write::write_gpx(&gpx));
    let mut buf = Vec::new();
    formats::write_kml_to(&gpx, &mut buf).unwrap();
    assert_eq!(String::from_utf8(buf).unwrap(), formats::write_kml(&gpx));
    let mut buf = Vec::new();
    formats::write_tcx_to(&gpx, &mut buf).unwrap();
    assert_eq!(String::from_utf8(buf).unwrap(), formats::write_tcx(&gpx));
    // G/Ç hatası döndürülür.
    struct Full;
    impl std::io::Write for Full {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("dolu"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert!(write::write_gpx_to(&gpx, &mut Full).is_err());
}

#[test]
fn macos_copy_suffixed_extensions() {
    use formats::{format_of_ext, is_supported_ext};
    assert_eq!(format_of_ext("gpx 2"), Some("gpx"));
    assert_eq!(format_of_ext("GPX 13"), Some("gpx"));
    assert_eq!(format_of_ext("fit 2"), Some("fit"));
    assert_eq!(format_of_ext("gpx"), Some("gpx"));
    assert_eq!(format_of_ext("gpx copy"), None);
    assert_eq!(format_of_ext("gpx "), None);
    assert!(!is_supported_ext("txt 2"));
}

#[test]
fn hour_points_skip_points_next_to_flight_gaps() {
    // Yerde 2 saat, 2 saatlik uçuş boşluğu, inişte boşluğun hemen ardından
    // havada tek nokta (ardından yine boşluk), sonra yerde.
    let mut seg: Vec<Point> = (0..24).map(|k| pt(40.9, 29.3, k * 300)).collect();
    let land = 4 * 3600;
    seg.push(pt(50.2, 12.2, land + 60)); // havada, iki uçuş boşluğu arasında
    seg.push(pt(50.97, 8.0, land + 1800)); // 117 km, 29 dk: yine uçuş hızı
    seg.extend((1..24).map(|k| pt(50.97, 8.0 + k as f64 * 1e-4, land + 1800 + k * 120)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let hours: Vec<[f64; 3]> = (0..6).map(|h| [(h * 3_600_000) as f64, 0.0, 0.0]).collect();
    let pts = hour_first_points(&gpx, &hours);
    // 4. saatte havadaki nokta değil, inişten sonraki yer noktası.
    let h4 = pts.iter().find(|(h, _)| *h == 4 * 3_600_000).unwrap().1;
    assert!((h4[1] - 50.97).abs() < 1e-6, "{h4:?}");
}

#[test]
fn hour_points_see_through_segment_boundaries() {
    // İnişte kayıt ikiye bölünmüş: ilk segment aynı noktada iki kez biter
    // (0 m), ikinci segment uçuş hızında sürer.
    let mut a: Vec<Point> = (0..10)
        .map(|k| pt(50.2, 12.0 - k as f64 * 0.02, 1800 + k))
        .collect();
    let last = *a.last().unwrap();
    a.push(Point {
        time: Some(last.time.unwrap() + 1000),
        ..last
    });
    let b: Vec<Point> = (0..60)
        .map(|k| pt(50.2, last.lon - (k + 1) as f64 * 0.003, 1811 + k))
        .collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![a, b],
        }],
        ..Default::default()
    };
    let hours = vec![[0.0, 0.0, 0.0]];
    assert!(hour_first_points(&gpx, &hours).is_empty());
}

#[test]
fn jumps_between_segments_are_gaps() {
    // Konum geçmişi gibi her parçası ayrı segment olan kayıt: uçuş iki
    // segmentin arasında.
    let a: Vec<Point> = (0..5).map(|k| pt(40.89, 29.29, k * 600)).collect();
    let b: Vec<Point> = (0..5).map(|k| pt(50.2, 12.2, 7600 + k * 600)).collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![a, b],
        }],
        ..Default::default()
    };
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert_eq!(s.gaps.len(), 1);
    assert!(s.gaps[0].distance_m > 1_600_000.0);
    // Mesafeye katılmaz.
    assert!(s.stats.distance_m < 1.0);
}

#[test]
fn removes_segments_teleported_far_away() {
    // İstanbul'da kayıt; 3 segment boyunca önce okyanusta, sonra Boston'da
    // (GPS hatası); sonra yine İstanbul.
    let ist = |k: i64| pt(41.06, 28.98 + k as f64 * 1e-4, k * 60);
    let a: Vec<Point> = (0..30).map(ist).collect();
    let pac: Vec<Point> = (0..3)
        .map(|k| pt(42.34, -175.59, 1800 + 120 + k * 10))
        .collect();
    let bos1: Vec<Point> = (0..2)
        .map(|k| pt(42.366, -71.02, 1800 + 135 + k * 30))
        .collect();
    let bos2: Vec<Point> = (0..150)
        .map(|k| pt(42.366, -71.019, 1800 + 200 + k * 60))
        .collect();
    let back: Vec<Point> = (0..30).map(|k| ist(200 + k)).collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![a, pac, bos1, bos2, back],
        }],
        ..Default::default()
    };
    let p = prepare(gpx, &StatsConfig::default());
    let segs = &p.gpx.tracks[0].segments;
    // Ortadaki üç segment atılır (uçtakiler duraklama sadeleştirmesiyle
    // kısalabilir ama boşalmaz).
    let lens: Vec<usize> = segs.iter().map(|s| s.len()).collect();
    assert_eq!(&lens[1..4], &[0, 0, 0], "{lens:?}");
    assert!(lens[0] > 0 && lens[4] > 0, "{lens:?}");
    assert_eq!(p.removed, 155);
    let s = summarize(&p.gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    let b = s.stats.bbox.unwrap();
    assert!(b[0] > 28.0, "{b:?}");

    // Gerçek uçuş (gidip orada kalınan) silinmez.
    let there: Vec<Point> = (0..30)
        .map(|k| pt(50.9, 7.0 + k as f64 * 1e-4, 9000 + k * 60))
        .collect();
    let fly = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![(0..30).map(ist).collect(), there],
        }],
        ..Default::default()
    };
    assert_eq!(prepare(fly, &StatsConfig::default()).removed, 0);
}

#[test]
fn sparse_records_get_a_longer_gap_threshold() {
    // 12 dakikada bir nokta alan konum geçmişi: her adım ~5 km'lik sürüş,
    // boşluk değil. Kayıt 3 saat kesilip 20 km ötede sürdüğünde boşluk var.
    let mut a: Vec<Point> = (0..20)
        .map(|k| pt(41.0, 29.0 + k as f64 * 0.06, k * 720))
        .collect();
    a.extend((0..20).map(|k| pt(41.0, 30.4 + k as f64 * 0.06, 19 * 720 + 3 * 3600 + k * 720)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![a],
        }],
        ..Default::default()
    };
    let s = summarize(&gpx, "a.gpx", 0, &StatsConfig::default()).unwrap();
    assert_eq!(s.gaps.len(), 1);
    assert!(s.stats.distance_m > 180_000.0);
    // Ama haritada 12 dakikalık 5 km'lik adımlar düz çizgiyle birleştirilmez
    // (şehri kat eden çizgiler).
    assert!(s.lines.iter().all(|l| l.len() < 2), "{:?}", s.lines.len());
}

#[test]
fn detail_keeps_every_recorded_hour() {
    // Uzun duraklar ve seyrek günler: mesafeye göre seyreltme onları
    // atabilir; her kayıtlı saatin ilk noktası örneklerde kalır.
    let mut seg: Vec<Point> = (0..20_000)
        .map(|i| pt(41.0, 29.0 + i as f64 * 1e-5, i))
        .collect();
    // Sonraki 10 gün: günde bir kez yerinde tek nokta.
    seg.extend((1..=10).map(|k| pt(41.0, 29.2, 20_000 + k * 86_400)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let d = build_detail(&gpx);
    let days: std::collections::BTreeSet<i64> = d
        .time
        .iter()
        .flatten()
        .map(|t| t.div_euclid(86_400_000))
        .collect();
    assert_eq!(days.len(), 11);
}

#[test]
fn fit_running_cadence_round_trips() {
    // Kayıtta adım/dk (171); FIT'e tek bacak (85 + 0,5) yazılır, okununca
    // yine 171 olur.
    let seg: Vec<Point> = (0..5)
        .map(|k| Point {
            cad: Some(171.0),
            ..pt(41.0, 29.0 + k as f64 * 1e-4, 1_700_000_000 + k)
        })
        .collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let back = formats::parse_fit(&formats::write_fit(&gpx, Activity::Run)).unwrap();
    let cads: Vec<Option<f32>> = back.tracks[0].segments[0].iter().map(|p| p.cad).collect();
    assert!(cads.iter().all(|c| *c == Some(171.0)), "{cads:?}");
    // Bisiklette kadans olduğu gibi yazılır.
    let back = formats::parse_fit(&formats::write_fit(&gpx, Activity::Bike)).unwrap();
    assert_eq!(back.tracks[0].segments[0][0].cad, Some(171.0));
}

#[test]
fn fit_keeps_real_times_after_untimed_points() {
    let t = 1_700_000_000;
    let mut seg: Vec<Point> = (0..2)
        .map(|k| Point {
            time: None,
            ..pt(41.0, 29.0 + k as f64 * 1e-4, 0)
        })
        .collect();
    seg.extend((0..2).map(|k| pt(41.0, 29.0002 + k as f64 * 1e-4, t + k)));
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let back = formats::parse_fit(&formats::write_fit(&gpx, Activity::Bike)).unwrap();
    let times: Vec<i64> = back.tracks[0].segments[0]
        .iter()
        .map(|p| p.time.unwrap() / 1000 - t)
        .collect();
    assert_eq!(times, vec![-2, -1, 0, 1]);
}

#[test]
fn merge_and_trim_keep_tracks_and_routes() {
    let trk = |name: &str, t0: i64| parse::Track {
        name: Some(name.into()),
        segments: vec![(0..3)
            .map(|k| pt(41.0, 29.0 + k as f64 * 1e-4, t0 + k))
            .collect()],
    };
    let a = parse::Gpx {
        tracks: vec![trk("T1", 0), trk("T2", 100)],
        routes: vec![trk("R", 0)],
        ..Default::default()
    };
    let b = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            ..trk("", 1000)
        }],
        name: Some("B".into()),
        ..Default::default()
    };
    let cut = ops::trim(&a, 1, 4).unwrap();
    assert_eq!(cut.routes.len(), 1);
    let m = ops::merge(vec![b, a], None);
    let names: Vec<_> = m
        .tracks
        .iter()
        .map(|t| t.name.clone().unwrap_or_default())
        .collect();
    assert_eq!(names, vec!["T1", "T2", "B"]);
    assert_eq!(m.routes.len(), 1);
}

#[test]
fn tcx_gives_every_point_a_time_and_kml_writes_single_points() {
    let t = 1_700_000_000;
    let untimed = |lon: f64| Point {
        time: None,
        ..pt(41.0, lon, 0)
    };
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: Some("a<b".into()),
            segments: vec![
                vec![untimed(29.0), pt(41.0, 29.001, t), untimed(29.002)],
                vec![pt(41.0, 29.01, t + 100)],
            ],
        }],
        ..Default::default()
    };
    let tcx = formats::write_tcx(&gpx);
    assert_eq!(
        tcx.matches("<Trackpoint>").count(),
        tcx.matches("<Time>").count()
    );
    let back = formats::parse_tcx(tcx.as_bytes()).unwrap();
    let times: Vec<i64> = back
        .tracks
        .iter()
        .flat_map(|t| t.segments.iter().flatten())
        .map(|p| p.time.unwrap() / 1000 - t)
        .collect();
    assert_eq!(times, vec![-1, 0, 1, 100]);

    let kml = formats::write_kml(&gpx);
    assert!(kml.contains("<name>a&lt;b</name>"));
    assert!(kml.contains("<Point><coordinates>29.01,41</coordinates></Point>"));
}

#[test]
fn kml_keeps_sensor_data() {
    let mut seg: Vec<Point> = (0..3)
        .map(|k| Point {
            hr: Some(120.0 + k as f32),
            power: Some(200.0),
            ..pt(41.0, 29.0 + k as f64 * 1e-4, 1_700_000_000 + k)
        })
        .collect();
    seg[1].hr = None;
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let kml = formats::write_kml(&gpx);
    assert!(!kml.contains("cadence"), "{kml}");
    let back = formats::parse_kml(kml.as_bytes()).unwrap();
    let pts = &back.tracks[0].segments[0];
    let hr: Vec<_> = pts.iter().map(|p| p.hr).collect();
    assert_eq!(hr, vec![Some(120.0), None, Some(122.0)]);
    assert!(pts
        .iter()
        .all(|p| p.power == Some(200.0) && p.cad.is_none()));
}

#[test]
fn parses_iso_8601_variants() {
    let utc7 = parse::parse_time("2024-01-01T07:00:00Z");
    assert!(utc7.is_some());
    for s in [
        "2024-01-01T10:00:00+0300",
        "2024-01-01T10:00:00+03",
        "2024-01-01T10:00:00+03:00",
        "2024-01-01T10:00:00.000+0300",
        "2024-01-01T07:00:00 Z",
        "2024-01-01T07:00Z",
        "2024-01-01t07:00:00z",
        "2024-01-01 07:00:00",
    ] {
        assert_eq!(parse::parse_time(s), utc7, "{s}");
    }
    assert_eq!(parse::parse_time("2024-01-01T07:00"), utc7);
    assert_eq!(parse::parse_time("dün"), None);
}

#[test]
fn sparse_steps_count_as_moving_time() {
    // 15 dakikada bir nokta, adım başına ~1 km: yürüyüş.
    let seg: Vec<Point> = (0..20)
        .map(|k| pt(41.0 + k as f64 * 0.009, 29.0, k * 900))
        .collect();
    let s = track_stats(&[&seg], &StatsConfig::default());
    let moving_h = s.moving_ms.unwrap_or(0) as f64 / 3_600_000.0;
    assert!((moving_h - 4.75).abs() < 0.01, "{moving_h}");
    let v = s.avg_moving_speed_ms.unwrap() * 3.6;
    assert!((3.5..4.5).contains(&v), "{v}");
}

#[test]
fn range_stats_use_the_whole_record_gap_rule() {
    // 1 sn'lik 300 nokta, 12 dk / 3 km'lik bir adım, sonra 5 dk'da bir 400
    // nokta: kaydın kuralında (15 dk) o adım boşluk değil; grafikle aynı.
    let mut seg: Vec<Point> = (0..300)
        .map(|k| pt(41.0, 29.0 + k as f64 * 1e-5, k))
        .collect();
    let last = seg[299];
    seg.push(pt(41.027, last.lon, 299 + 720));
    for k in 1..400 {
        seg.push(pt(41.027 + k as f64 * 1e-3, last.lon, 299 + 720 + k * 300));
    }
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let d = build_detail(&gpx);
    let k = d.idx.iter().position(|&i| i >= 310).unwrap();
    let chart = d.dist[k] - d.dist[0];
    let st = range_stats(&gpx, 0, d.idx[k] as usize, &StatsConfig::default());
    assert!(
        (st.distance_m - chart).abs() < 1.0,
        "{} {}",
        st.distance_m,
        chart
    );
}

#[test]
fn kml_keeps_times_of_partly_timed_segments() {
    let t = 1_700_000_000;
    let untimed = |lon: f64| Point {
        time: None,
        ..pt(41.0, lon, 0)
    };
    let seg = vec![
        pt(41.0, 29.000, t),
        pt(41.0, 29.001, t + 1),
        pt(41.0, 29.002, t + 2),
        untimed(29.003),
        untimed(29.004),
        pt(41.0, 29.005, t + 5),
        pt(41.0, 29.006, t + 6),
    ];
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let kml = formats::write_kml(&gpx);
    assert_eq!(kml.matches("<gx:Track>").count(), 2, "{kml}");
    assert_eq!(kml.matches("<LineString>").count(), 1);
    let back = formats::parse_kml(kml.as_bytes()).unwrap();
    let timed = back.tracks[0]
        .segments
        .iter()
        .flatten()
        .filter(|p| p.time.is_some())
        .count();
    assert_eq!(timed, 5);
}

#[test]
fn detail_speed_handles_sparse_points_and_jumps_after_stops() {
    // 12 dakikada bir nokta, adım başına 5 km (25 km/sa): her noktada hız var.
    let sparse: Vec<Point> = (0..10)
        .map(|k| pt(41.0 + k as f64 * 0.045, 29.0, k * 720))
        .collect();
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![sparse],
        }],
        ..Default::default()
    };
    let d = build_detail(&gpx);
    assert!(d.speed.iter().all(|v| v.is_some()), "{:?}", d.speed);
    let v = d.speed[5].unwrap();
    assert!((20.0..30.0).contains(&v), "{v}");

    // Durakta 40 dk nokta yok; sonra 1 sn'de 300 m'lik konum düzeltmesi ve
    // 10 m/sn sürüş: grafikte ~1000 km/sa'lik sıçrama olmamalı.
    let mut seg: Vec<Point> = (0..30)
        .map(|k| pt(41.0, 29.0 + k as f64 * 1e-4, k))
        .collect();
    let t0 = 29 + 2400;
    seg.push(pt(41.0, 29.0029, t0));
    seg.push(pt(41.0027, 29.0029, t0 + 1));
    for k in 1..40 {
        seg.push(pt(41.0027 + k as f64 * 9e-5, 29.0029, t0 + 1 + k));
    }
    let gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let d = build_detail(&gpx);
    let max = d.speed.iter().flatten().fold(0.0f32, |m, v| m.max(*v));
    assert!(max < 200.0, "{max}");
}

#[test]
fn flight_altitude_is_not_an_elevation_record() {
    // Yerde 100 m; sonra 10 dk uçuş (10 km yükseklik, 800 km/sa), uçuşun
    // sonunda neredeyse duran bir nokta 6.600 m'de; sonra yine yerde.
    let ground = |k: i64, t: i64| Point {
        ele: Some(100.0 + (k % 3) as f32),
        ..pt(41.0, 29.0 + k as f64 * 1e-4, t)
    };
    let mut seg: Vec<Point> = (0..30).map(|k| ground(k, k * 10)).collect();
    for k in 0..20 {
        seg.push(Point {
            ele: Some(10_000.0),
            ..pt(41.0, 29.1 + k as f64 * 0.02, 300 + k * 9)
        });
    }
    let last = *seg.last().unwrap();
    seg.push(Point {
        ele: Some(6600.0),
        ..pt(41.0, last.lon + 1e-5, 300 + 20 * 9)
    });
    seg.extend((0..30).map(|k| Point {
        ele: Some(100.0),
        ..pt(41.0, last.lon + 0.01 + k as f64 * 1e-4, 2000 + k * 10)
    }));
    let s = track_stats(&[&seg], &StatsConfig::default());
    assert!(s.max_ele_m.unwrap() < 200.0, "{:?}", s.max_ele_m);
    assert!(
        s.elevation_gain_m.unwrap_or(0.0) < 50.0,
        "{:?}",
        s.elevation_gain_m
    );
}

#[test]
fn reads_google_location_history_formats() {
    use crate::google::{is_google_file_name, parse_google};
    // Eski Records.json: zaman ISO ya da ms; doğruluğu kötü nokta atılır.
    let records = r#"{"locations":[
        {"latitudeE7":410000000,"longitudeE7":290000000,"timestamp":"2019-06-04T08:00:00.000Z","accuracy":10,"altitude":50},
        {"latitudeE7":410100000,"longitudeE7":290100000,"timestampMs":"1559635260000","accuracy":20},
        {"latitudeE7":420000000,"longitudeE7":300000000,"timestamp":"2019-06-04T08:02:00Z","accuracy":5000}
    ]}"#;
    let g = parse_google(records.as_bytes()).unwrap();
    let pts = &g.tracks[0].segments[0];
    assert_eq!(pts.len(), 2);
    assert_eq!(pts[0].ele, Some(50.0));
    assert!(g
        .name
        .as_deref()
        .unwrap()
        .starts_with("Google konum geçmişi 2019-06-04"));

    // Anlamsal aylık dosya: yolculuk yolu ve durak.
    let semantic = r#"{"timelineObjects":[
        {"activitySegment":{"startLocation":{"latitudeE7":410000000,"longitudeE7":290000000},
          "endLocation":{"latitudeE7":410500000,"longitudeE7":290500000},
          "duration":{"startTimestamp":"2019-06-04T08:00:00Z","endTimestamp":"2019-06-04T09:00:00Z"},
          "waypointPath":{"waypoints":[{"latE7":410200000,"lngE7":290200000}]}}},
        {"placeVisit":{"location":{"latitudeE7":410500000,"longitudeE7":290500000,"name":"Ev"},
          "duration":{"startTimestamp":"2019-06-04T09:00:00Z","endTimestamp":"2019-06-04T18:00:00Z"}}}
    ]}"#;
    let g = parse_google(semantic.as_bytes()).unwrap();
    let pts = &g.tracks[0].segments[0];
    assert_eq!(pts.len(), 4, "{pts:?}");
    assert!(pts.windows(2).all(|w| w[0].time <= w[1].time));

    // Android Zaman Çizelgesi.
    let android = r#"[
        {"startTime":"2024-05-01T10:00:00.000+03:00","endTime":"2024-05-01T11:00:00.000+03:00",
         "activity":{"start":"geo:41.0,29.0","end":"geo:41.05,29.05"}},
        {"startTime":"2024-05-01T10:00:00.000+03:00","endTime":"2024-05-01T12:00:00.000+03:00",
         "timelinePath":[{"point":"geo:41.02,29.02","durationMinutesOffsetFromStartTime":"20"}]}
    ]"#;
    let g = parse_google(android.as_bytes()).unwrap();
    assert_eq!(g.tracks[0].segments[0].len(), 3);

    // iOS Zaman Çizelgesi.
    let ios = r#"{"semanticSegments":[{"startTime":"2024-05-01T10:00:00+03:00","endTime":"2024-05-01T11:00:00+03:00",
        "timelinePath":[{"point":"41.0°, 29.0°","time":"2024-05-01T10:05:00+03:00"}]}],
        "rawSignals":[{"position":{"LatLng":"41.01°, 29.01°","accuracyMeters":12,"timestamp":"2024-05-01T10:06:00+03:00"}}]}"#;
    let g = parse_google(ios.as_bytes()).unwrap();
    assert_eq!(g.tracks[0].segments[0].len(), 2);

    assert!(parse_google(br#"{"name":"baska bir json"}"#).is_err());
    assert!(is_google_file_name("Records.json"));
    assert!(is_google_file_name("2019_JUNE.json"));
    assert!(is_google_file_name("location-history.json"));
    assert!(!is_google_file_name("package.json"));
}

#[test]
fn dem_replaces_and_interpolates_elevation() {
    // 1 km düz yol, GPS yüksekliği gürültülü; arazi 100 m'den 200 m'ye çıkıyor.
    let seg: Vec<Point> = (0..=100)
        .map(|k| Point {
            ele: Some(if k % 2 == 0 { 50.0 } else { 300.0 }),
            ..pt(41.0, 29.0 + k as f64 * 0.000119, k)
        })
        .collect();
    let mut gpx = parse::Gpx {
        tracks: vec![parse::Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let mut asked = 0;
    let n = dem::apply_dem::<()>(&mut gpx, |coords| {
        asked += coords.len();
        Ok(coords
            .iter()
            .map(|&(_, lon)| Some(100.0 + (lon - 29.0) / 0.0119 * 100.0))
            .collect())
    })
    .unwrap();
    assert_eq!(n, 101);
    assert!(asked < 30, "{asked}");
    let pts = &gpx.tracks[0].segments[0];
    assert!((pts[0].ele.unwrap() - 100.0).abs() < 0.5);
    assert!((pts[100].ele.unwrap() - 200.0).abs() < 0.5);
    assert!((pts[50].ele.unwrap() - 150.0).abs() < 2.0);
    let s = track_stats(&[pts], &StatsConfig::default());
    assert!(
        (s.elevation_gain_m.unwrap() - 100.0).abs() < 5.0,
        "{:?}",
        s.elevation_gain_m
    );
}
