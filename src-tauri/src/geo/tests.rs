use super::*;

#[test]
fn turkish_place_names() {
    assert_eq!(turkish("Kadikoy"), "Kadıköy");
    assert_eq!(turkish("UEskuedar"), "Üsküdar");
    assert_eq!(turkish("Sisli"), "Şişli");
    assert_eq!(turkish("Ankara"), "Ankara");
    // Şişli'deki bir nokta.
    assert_eq!(place_at(28.987, 41.060).as_deref(), Some("Şişli"));
}

#[test]
fn hourly_visits_are_run_length_compressed() {
    use gpx_core::parse::{Gpx, Point, Track};
    let pt = |lon: f64, lat: f64, h: i64, m: i64| Point {
        lat,
        lon,
        time: Some(h * 3_600_000 + m * 60_000),
        ..Default::default()
    };
    // Şişli'de iki saat, sonra Kadıköy, açık denizde bir saat, yine Şişli.
    let seg = vec![
        pt(28.987, 41.060, 0, 0),
        pt(28.987, 41.061, 0, 30),
        pt(28.988, 41.060, 1, 0),
        pt(29.03, 40.99, 2, 5),
        pt(29.031, 40.99, 2, 50),
        pt(-30.0, 40.0, 3, 1),
        pt(-30.0, 40.0, 3, 2),
        pt(28.987, 41.060, 4, 0),
        pt(28.987, 41.060, 4, 1),
    ];
    let gpx = Gpx {
        tracks: vec![Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let hours: Vec<[f64; 3]> = (0..5).map(|h| [(h * 3_600_000) as f64, 0.0, 0.0]).collect();
    let v = visits(&gpx, &hours);
    let names: Vec<(i64, &str, &str)> = v
        .iter()
        .map(|(h, c, n)| (*h, c.as_str(), n.as_str()))
        .collect();
    assert_eq!(names.len(), 3, "{names:?}");
    assert_eq!(names[0], (0, "TR", "Şişli"));
    assert_eq!(names[1].0, 2 * 3_600_000);
    assert_eq!(names[1].1, "TR");
    assert_ne!(names[1].2, "Şişli");
    assert_eq!(names[2], (4 * 3_600_000, "TR", "Şişli"));
}

#[test]
fn visits_skip_flights_and_brief_countries() {
    use gpx_core::parse::{Gpx, Point, Track};
    let pt = |lon: f64, lat: f64, s: i64| Point {
        lat,
        lon,
        time: Some(s * 1000),
        ..Default::default()
    };
    let mut seg = Vec::new();
    // İstanbul'da 3 saat.
    for k in 0..36 {
        seg.push(pt(28.987, 41.060, k * 300));
    }
    // İnişte Çek sınırının üstünden 800 km/sa ile geçiş (Aš yakını).
    for k in 0..20 {
        seg.push(pt(12.10 - k as f64 * 0.03, 50.20, 3 * 3600 + 7200 + k * 5));
    }
    // Köln'de 4 saat.
    for k in 0..48 {
        seg.push(pt(6.96, 50.94, 6 * 3600 + k * 300));
    }
    // Köln'den bir saatliğine (tek saat) Hollanda sınırına yakın tek nokta.
    seg.push(pt(6.02, 50.85, 11 * 3600));
    seg.push(pt(6.96, 50.94, 12 * 3600 + 600));
    seg.push(pt(6.96, 50.94, 13 * 3600));
    let gpx = Gpx {
        tracks: vec![Track {
            name: None,
            segments: vec![seg],
        }],
        ..Default::default()
    };
    let hours: Vec<[f64; 3]> = (0..14)
        .map(|h| [(h * 3_600_000) as f64, 0.0, 0.0])
        .collect();
    let v = visits(&gpx, &hours);
    let ccs: std::collections::BTreeSet<&str> = v.iter().map(|(_, c, _)| c.as_str()).collect();
    assert_eq!(ccs, ["DE", "TR"].into_iter().collect(), "{v:?}");
}

fn ccs(list: &[&str]) -> Vec<String> {
    let per_hour = list
        .iter()
        .enumerate()
        .map(|(i, c)| (i as i64 * 3_600_000, (*c).to_owned(), format!("{c}{i}")))
        .collect();
    drop_brief_countries(per_hour)
        .into_iter()
        .map(|(_, c, _)| c)
        .collect()
}

#[test]
fn brief_countries_rule() {
    // Tek ülke hiçbir zaman atılmaz.
    assert_eq!(ccs(&["TR"]), ["TR"]);
    assert!(ccs(&[]).is_empty());
    // Arada kalan tek saatlik ülke atılır, diğerleri kalır.
    assert_eq!(ccs(&["TR", "GR", "TR"]), ["TR", "TR"]);
    // Sınır bölgesinde gidip gelme: toplamlar 2 saat ve üstü.
    assert_eq!(
        ccs(&["NL", "DE", "NL", "DE", "NL", "DE"]),
        ["NL", "DE", "NL", "DE", "NL", "DE"]
    );
    assert_eq!(ccs(&["NL", "DE", "NL", "DE"]), ["NL", "DE", "NL", "DE"]);
    // Yeni ülkede bir saat sonra biten ya da başlayan kayıt sayılır.
    assert_eq!(ccs(&["TR", "TR", "GR"]), ["TR", "TR", "GR"]);
    assert_eq!(ccs(&["BG", "TR", "TR"]), ["BG", "TR", "TR"]);
    assert_eq!(ccs(&["TR", "GR"]), ["TR", "GR"]);
    // Toplamı 2 saat olan ülke arada kalsa da sayılır.
    assert_eq!(ccs(&["TR", "GR", "GR", "TR"]), ["TR", "GR", "GR", "TR"]);
    assert_eq!(ccs(&["TR", "GR", "TR", "GR"]), ["TR", "GR", "TR", "GR"]);
    // Farklı ülkeler arasında kalan tek saat de atılır.
    assert_eq!(ccs(&["DE", "NL", "BE", "BE"]), ["DE", "BE", "BE"]);
}

#[test]
fn untimed_records_use_start_and_end_places() {
    let v = untimed_visits(Some([28.987, 41.060]), Some([28.987, 41.060]), None);
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0], (0, "TR".into(), "Şişli".into()));
    // Başlangıç zamanı varsa saat başına yuvarlanır; açık deniz atlanır.
    let v = untimed_visits(
        Some([-30.0, 40.0]),
        Some([28.987, 41.060]),
        Some(2 * 3_600_000 + 5),
    );
    assert_eq!(v, [(2 * 3_600_000, "TR".into(), "Şişli".into())]);
    assert!(untimed_visits(None, None, None).is_empty());
}
