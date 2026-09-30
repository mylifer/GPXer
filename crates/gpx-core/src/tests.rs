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
