use super::*;
use parse::Point;

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
    assert_eq!(d.dist.len(), PROFILE_MAX_POINTS);
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
