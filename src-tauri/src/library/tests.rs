use super::*;
use crate::geo::turkish;

fn temp_root(tag: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!("gpxer-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn track(lat: &str) -> String {
    format!(
        r#"<gpx><trk><trkseg><trkpt lat="{lat}" lon="29"/><trkpt lat="41.01" lon="29"/></trkseg></trk></gpx>"#
    )
}

#[test]
fn library_copies_and_detects_duplicates() {
    let root = temp_root("lib");
    let src = root.join("src");
    std::fs::create_dir_all(src.join("alt")).unwrap();
    std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
    std::fs::write(src.join("a-kopya.gpx"), track("41.000")).unwrap();
    std::fs::write(src.join("alt").join("a.gpx"), track("41.002")).unwrap();
    let cfg = StatsConfig::default();
    let s = |p: &Path| p.to_string_lossy().into_owned();

    let lib = Library::open(&root).unwrap();
    let LoadResult::Ok { file } = lib.load(s(&src.join("a.gpx")), &cfg, None) else {
        panic!()
    };
    assert_eq!(Path::new(&file.path), lib.dir.join("a.gpx"));
    assert_eq!(file.file_name, "a.gpx");
    // Konumdan saat dilimi ve yer adı bulunur.
    assert_eq!(file.time_zone.as_deref(), Some("Europe/Istanbul"));
    assert!(file.start_place.is_some(), "{:?}", file.start_place);
    // Zamansız kayıt da geçtiği ülkede sayılır.
    assert!(file.hours.is_empty());
    assert_eq!(file.visits.len(), 1, "{:?}", file.visits);
    assert_eq!(file.visits[0].1, "TR");
    assert_eq!(lib.cached_activity(&file.path), Some(file.activity));
    assert_eq!(lib.cached_activity("/yok/boyle.gpx"), None);

    let LoadResult::Duplicate { existing, .. } = lib.load(s(&src.join("a-kopya.gpx")), &cfg, None)
    else {
        panic!()
    };
    assert_eq!(Path::new(&existing), lib.dir.join("a.gpx"));

    // Aynı adlı ama farklı içerikli dosya yeni adla kopyalanır.
    let LoadResult::Ok { file } = lib.load(s(&src.join("alt").join("a.gpx")), &cfg, None) else {
        panic!()
    };
    assert_eq!(Path::new(&file.path), lib.dir.join("a (2).gpx"));
    lib.flush_cache().unwrap();

    // Yeniden başlatma: önbellek diskten okunur, kopyalar yine yakalanır.
    let lib2 = Library::open(&root).unwrap();
    // Kütüphane kopyalarının tam özeti, kaynak dosyaların yalnızca parmak izi
    // önbellekte.
    {
        let cache = lib2.cache.lock().unwrap();
        assert_eq!((cache.entries.len(), cache.seen.len()), (2, 3));
    }
    for f in lib2.files() {
        assert!(matches!(lib2.load(f, &cfg, None), LoadResult::Ok { .. }));
    }
    // Değişmemiş kaynak dosya yeniden okunmadan kopya sayılır.
    let Some(LoadResult::Duplicate { existing, .. }) =
        lib2.quick_duplicate(&s(&src.join("a-kopya.gpx")), false)
    else {
        panic!()
    };
    assert_eq!(Path::new(&existing), lib2.dir.join("a.gpx"));
    assert!(lib2.quick_duplicate(&existing, false).is_none());
    assert!(matches!(
        lib2.load(s(&src.join("a.gpx")), &cfg, None),
        LoadResult::Duplicate { .. }
    ));
    assert_eq!(lib2.files().len(), 2);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn imports_fit_as_gpx() {
    let root = temp_root("fit");
    let lib = Library::open(&root).unwrap();
    let src = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../crates/gpx-core/testdata/garmin-fenix-5-bike.fit"
    );
    let cfg = StatsConfig::default();
    let LoadResult::Ok { file } = lib.load(src.to_owned(), &cfg, None) else {
        panic!()
    };
    assert_eq!(
        Path::new(&file.path),
        lib.dir.join("garmin-fenix-5-bike.gpx")
    );
    assert_eq!(file.activity, Activity::Bike);
    // Kütüphanedeki GPX kopyası aynı kayıt sayılır.
    assert!(matches!(
        lib.load(src.to_owned(), &cfg, None),
        LoadResult::Duplicate { .. }
    ));
    let lib2 = Library::open(&root).unwrap();
    assert!(matches!(
        lib2.load(file.path.clone(), &cfg, None),
        LoadResult::Ok { .. }
    ));
    assert!(matches!(
        lib2.load(src.to_owned(), &cfg, None),
        LoadResult::Duplicate { .. }
    ));
    assert_eq!(turkish("UEskuedar"), "Üsküdar");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn cache_invalidates_on_change() {
    let root = temp_root("cache");
    let lib = Library::open(&root).unwrap();
    let p = lib.write_new("x/y:z", &track("41.0")).unwrap();
    assert_eq!(p.file_name().unwrap(), "x-y-z.gpx");
    let ps = p.to_string_lossy().into_owned();
    let cfg = StatsConfig::default();
    let (a, _) = lib.summarize(&ps, &cfg, None).unwrap();
    // Farklı ayarla yeniden hesaplanır.
    let strict = StatsConfig {
        moving_speed_ms: 9.0,
        ..cfg
    };
    lib.summarize(&ps, &strict, None).unwrap();
    assert_eq!(lib.cache.lock().unwrap().entries[&ps].cfg, strict);
    // İçerik değişince yeniden okunur.
    std::fs::write(&p, track("40.0")).unwrap();
    let (b, _) = lib.summarize(&ps, &cfg, None).unwrap();
    assert_ne!(a.stats.distance_m, b.stats.distance_m);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn trash_and_restore() {
    let root = temp_root("trash");
    let lib = Library::open(&root).unwrap();
    let cfg = StatsConfig::default();
    let p = lib.write_new("a", &track("41.0")).unwrap();
    let ps = p.to_string_lossy().into_owned();
    assert!(matches!(
        lib.load(ps.clone(), &cfg, None),
        LoadResult::Ok { .. }
    ));
    let items = lib.trash(std::slice::from_ref(&ps)).unwrap();
    assert_eq!(items.len(), 1);
    assert!(!p.exists());
    assert!(lib.files().is_empty());
    let back = lib.restore(&items);
    assert_eq!(back, vec![(items[0].trashed.clone(), ps.clone())]);
    assert!(matches!(lib.load(ps, &cfg, None), LoadResult::Ok { .. }));
    // Eski çöp dosyaları temizlenir.
    let items = lib.trash(&lib.files()).unwrap();
    lib.purge_trash(now_ms() + 1);
    assert!(!Path::new(&items[0].trashed).exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn safe_names() {
    assert_eq!(safe_stem("CON"), "_CON");
    assert_eq!(safe_stem("lpt1.txt"), "_lpt1.txt");
    assert_eq!(safe_stem("COM0"), "COM0");
    assert_eq!(safe_stem("Konsol"), "Konsol");
    assert_eq!(safe_stem("iz. . "), "iz");
    assert_eq!(safe_stem(" .. "), "iz");
    let long = format!("{} x", "a".repeat(149));
    assert_eq!(safe_stem(&long), "a".repeat(149));
}

#[test]
fn dismissed_until_restored() {
    let root = temp_root("dismiss");
    let lib = Library::open(&root).unwrap();
    let cfg = StatsConfig::default();
    let src = root.join("izlenen");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
    let sp = src.join("a.gpx").to_string_lossy().into_owned();
    let (_, fp) = lib.summarize(&sp, &cfg, None).unwrap();
    let LoadResult::Ok { file } = lib.load(sp.clone(), &cfg, None) else {
        panic!()
    };
    assert!(!lib.is_dismissed(fp));
    let items = lib.trash(std::slice::from_ref(&file.path)).unwrap();
    assert!(lib.is_dismissed(fp));
    // Yeniden başlatmada da hatırlanır.
    assert!(Library::open(&root).unwrap().is_dismissed(fp));
    let back = lib.restore(&items);
    assert_eq!(back.len(), 1);
    assert!(!lib.is_dismissed(fp));
    assert!(!Library::open(&root).unwrap().is_dismissed(fp));
    // Aynı ad doluysa geri gelen dosya yeni ad alır.
    let items = lib.trash(std::slice::from_ref(&back[0].1)).unwrap();
    lib.write_new("a", &track("40.0")).unwrap();
    let back = lib.restore(&items);
    assert_eq!(Path::new(&back[0].1), lib.dir.join("a (2).gpx"));
    // Silindikten sonra aynı içerik yeniden içe aktarıldıysa geri alma onu
    // ikinci kez getirmez (listede görünmeyen kopya kalıyordu).
    let items = lib.trash(std::slice::from_ref(&back[0].1)).unwrap();
    lib.undismiss(fp);
    assert!(matches!(
        lib.load(sp.clone(), &cfg, None),
        LoadResult::Ok { .. }
    ));
    assert!(lib.restore(&items).is_empty());
    // Kütüphane dışındaki yol reddedilir.
    assert!(lib.check(&sp).is_err());
    assert!(lib.check(&back[0].1).is_ok());
    let up = lib.dir.join("..").join("x.gpx");
    assert!(lib.check(&up.to_string_lossy()).is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dismissal_blocks_only_implicit_loads() {
    let root = temp_root("explicit");
    let lib = Library::open(&root).unwrap();
    let cfg = StatsConfig::default();
    let src = root.join("izlenen");
    std::fs::create_dir_all(&src).unwrap();
    std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
    let sp = src.join("a.gpx").to_string_lossy().into_owned();
    let LoadResult::Ok { file } = lib.load(sp.clone(), &cfg, None) else {
        panic!()
    };
    let (_, fp) = lib.summarize(&sp, &cfg, None).unwrap();
    lib.trash(std::slice::from_ref(&file.path)).unwrap();
    // İzlenen klasörden kendiliğinden gelen yükleme atlanır, elle açılan
    // atlanmaz.
    assert!(lib.blocks(fp, &sp, false));
    assert!(!lib.blocks(fp, &sp, true));
    // Kütüphanedeki dosyalar hiçbir zaman atlanmaz.
    let inside = lib.dir.join("a.gpx").to_string_lossy().into_owned();
    assert!(!lib.blocks(fp, &inside, false));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn restoring_older_trash_copy_clears_dismissal() {
    let root = temp_root("twice");
    let lib = Library::open(&root).unwrap();
    let cfg = StatsConfig::default();
    let p = lib.write_new("a", &track("41.0")).unwrap();
    let ps = p.to_string_lossy().into_owned();
    let (_, fp) = lib.summarize(&ps, &cfg, None).unwrap();
    assert!(matches!(
        lib.load(ps.clone(), &cfg, None),
        LoadResult::Ok { .. }
    ));
    let first = lib.trash(std::slice::from_ref(&ps)).unwrap();
    // Aynı içerik yeniden eklenip yeniden silinir.
    std::thread::sleep(std::time::Duration::from_millis(5));
    let q = lib.write_new("a", &track("41.0")).unwrap();
    let qs = q.to_string_lossy().into_owned();
    assert!(matches!(
        lib.load(qs.clone(), &cfg, None),
        LoadResult::Ok { .. }
    ));
    let second = lib.trash(std::slice::from_ref(&qs)).unwrap();
    assert_ne!(first[0].trashed, second[0].trashed);
    assert_eq!(lib.dismissed.lock().unwrap()[&fp].len(), 2);
    // Eskisi geri getirilince de kayıt silinmiş sayılmaz.
    assert_eq!(lib.restore(&first).len(), 1);
    assert!(!lib.is_dismissed(fp));
    assert!(!Library::open(&root).unwrap().is_dismissed(fp));
    // Eski biçimdeki dismissed.json okunur.
    std::fs::write(
        root.join("dismissed.json"),
        format!(r#"{{"{fp}":"/x/1-a.gpx"}}"#),
    )
    .unwrap();
    assert!(Library::open(&root).unwrap().is_dismissed(fp));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn unique_names_and_prepared_cache() {
    let root = temp_root("unique");
    let lib = Library::open(&root).unwrap();
    let a = lib.write_new("b", "1").unwrap();
    let b = lib.write_new("b", "2").unwrap();
    assert_eq!(b.file_name().unwrap(), "b (2).gpx");
    assert_eq!(std::fs::read_to_string(&a).unwrap(), "1");
    // Aynı anda yazılan kayıtlar farklı adlar alır.
    let lib_ref = &lib;
    let names: Vec<PathBuf> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..8)
            .map(|i| s.spawn(move || lib_ref.write_new("c", &i.to_string()).unwrap()))
            .collect();
        hs.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let set: std::collections::HashSet<_> = names.iter().collect();
    assert_eq!(set.len(), 8);

    let p = lib.write_new("d", &track("41.0")).unwrap();
    let ps = p.to_string_lossy().into_owned();
    let cfg = StatsConfig::default();
    let x = lib.prepared(&ps, &cfg).unwrap();
    let y = lib.prepared(&ps, &cfg).unwrap();
    assert!(Arc::ptr_eq(&x, &y));
    let other = StatsConfig {
        clean_spikes: false,
        ..cfg
    };
    assert!(!Arc::ptr_eq(&x, &lib.prepared(&ps, &other).unwrap()));
    assert_eq!(lib.prepared.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn empty_files_are_skipped_not_errors() {
    let root = temp_root("empty");
    let f = root.join("bos.gpx");
    // Geo Tracker'da başlatılıp hemen durdurulmuş kayıt: yalnızca üst bilgi.
    std::fs::write(
        &f,
        r#"<gpx version="1.1"><metadata><name>9 Tem 2023</name></metadata><trk><trkseg/></trk></gpx>"#,
    )
    .unwrap();
    let lib = Library::open(&root).unwrap();
    let r = lib.load(
        f.to_string_lossy().into_owned(),
        &StatsConfig::default(),
        None,
    );
    assert!(matches!(r, LoadResult::Empty { .. }));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn imports_macos_copy_suffixed_files() {
    let root = temp_root("suffix");
    let src = root.join("src");
    std::fs::create_dir_all(&src).unwrap();
    let f = src.join("yolculuk.gpx 2");
    std::fs::write(&f, track("41.3")).unwrap();
    assert!(is_track_file(&f));
    let lib = Library::open(&root).unwrap();
    let LoadResult::Ok { file } = lib.load(
        f.to_string_lossy().into_owned(),
        &StatsConfig::default(),
        None,
    ) else {
        panic!()
    };
    assert!(file.file_name.ends_with(".gpx"), "{}", file.file_name);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn long_names_fit_the_byte_limit() {
    let cyr = "д".repeat(120);
    assert!(safe_stem(&cyr).len() <= 150);
    let jp = "東".repeat(120);
    let s = safe_stem(&jp);
    assert!(s.len() <= 150 && s.chars().all(|c| c == '東'));
    let long = format!("{}.gpx", "д".repeat(120));
    let t = super::trash_name(1_759_000_000_000, &long);
    assert!(t.len() <= 240 && t.ends_with(".gpx") && t.starts_with("1759000000000-"));
}

#[test]
fn gps_glitch_abroad_is_not_a_visited_country_even_without_cleaning() {
    // İstanbul'da 3 saatlik kayıt; ortasında 20 dakika Boston'a sıçrayan
    // segmentler (GPS hatası). Temizlik kapalıyken de ABD sayılmamalı.
    let t = |s: i64| gpx_core::write::format_time((1_682_600_000 + s) * 1000);
    let pt = |lat: f64, lon: f64, s: i64| {
        format!(
            r#"<trkpt lat="{lat}" lon="{lon}"><time>{}</time></trkpt>"#,
            t(s)
        )
    };
    let seg = |pts: Vec<String>| format!("<trkseg>{}</trkseg>", pts.concat());
    let ist = |from: i64, to: i64| {
        seg((from..to)
            .step_by(60)
            .map(|s| pt(41.06, 28.98 + s as f64 * 1e-6, s))
            .collect())
    };
    // Gerçek kayıttaki gibi 3,5 saat (kısa süreli ülke ayıklamasına takılmaz).
    let boston = seg((0..158).map(|k| pt(42.39, -71.07, 3600 + k * 80)).collect());
    let gpx = format!(
        "<gpx><trk>{}{}{}</trk></gpx>",
        ist(0, 3590),
        boston,
        ist(16_300, 22_000)
    );
    let root = temp_root("glitch");
    let lib = Library::open(&root).unwrap();
    let src = root.join("g.gpx");
    std::fs::write(&src, gpx).unwrap();
    let cfg = StatsConfig {
        clean_spikes: false,
        ..Default::default()
    };
    let (s, _) = lib.summarize(&src.to_string_lossy(), &cfg, None).unwrap();
    assert!(!s.visits.is_empty());
    assert!(s.visits.iter().all(|v| v.1 == "TR"), "{:?}", s.visits);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn imports_google_takeout_json() {
    let root = temp_root("google");
    let lib = Library::open(&root).unwrap();
    let src = root.join("Records.json");
    let locs: Vec<String> = (0..60)
        .map(|k| {
            format!(
                r#"{{"latitudeE7":{},"longitudeE7":290000000,"timestamp":"{}","accuracy":10}}"#,
                410_000_000 + k * 1000,
                gpx_core::write::format_time(1_559_635_200_000 + k * 60_000)
            )
        })
        .collect();
    std::fs::write(&src, format!(r#"{{"locations":[{}]}}"#, locs.join(","))).unwrap();
    assert!(is_track_file(&src));
    assert!(!is_track_file(&root.join("package.json")));
    let LoadResult::Ok { file } = lib.load(
        src.to_string_lossy().into_owned(),
        &StatsConfig::default(),
        None,
    ) else {
        panic!()
    };
    assert!(file.path.ends_with("Records.gpx"), "{}", file.path);
    assert!(file
        .name
        .as_deref()
        .unwrap()
        .starts_with("Google konum geçmişi"));
    assert_eq!(file.stats.point_count + file.removed_points + file.collapsed_points, 60, "{} {} {}", file.stats.point_count, file.removed_points, file.collapsed_points);
    let _ = std::fs::remove_dir_all(&root);
}
