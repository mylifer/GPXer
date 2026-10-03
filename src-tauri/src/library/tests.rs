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
    // Kaynak dosyalar ve kütüphane kopyaları önbellekte.
    assert_eq!(lib2.cache.lock().unwrap().entries.len(), 3 + 2);
    for f in lib2.files() {
        assert!(matches!(lib2.load(f, &cfg, None), LoadResult::Ok { .. }));
    }
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
    let long = format!("{} x", "a".repeat(119));
    assert_eq!(safe_stem(&long), "a".repeat(119));
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
