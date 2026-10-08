use super::*;

/// Testte "kütüphane": bir klasör; aynı içerik ikinci kez eklenmez.
struct Dir(PathBuf);

impl LocalRecords for Dir {
    fn list(&self) -> BTreeMap<String, (PathBuf, u64, i64)> {
        std::fs::read_dir(&self.0)
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                let (s, m) = file_stat(&p)?;
                Some((p.file_name()?.to_string_lossy().into_owned(), (p, s, m)))
            })
            .collect()
    }
    fn stat(&self, name: &str) -> Option<(u64, i64)> {
        file_stat(&self.0.join(name))
    }
    fn add(&mut self, name: &str, bytes: &[u8]) -> Result<bool, String> {
        if self
            .list()
            .values()
            .any(|(p, _, _)| std::fs::read(p).unwrap() == bytes)
        {
            return Ok(false);
        }
        std::fs::write(self.0.join(name), bytes).map_err(|e| e.to_string())?;
        Ok(true)
    }
    fn replace(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        std::fs::write(self.0.join(name), bytes).map_err(|e| e.to_string())
    }
    fn remove(&mut self, name: &str) -> Result<(), String> {
        std::fs::remove_file(self.0.join(name)).map_err(|e| e.to_string())
    }
}

/// Bir cihaz: kütüphane klasörü, durum dosyası ve kayıt dışı veriler.
struct Device {
    lib: Dir,
    base: PathBuf,
    data: LocalData,
}

impl Device {
    fn new(root: &Path, name: &str) -> Self {
        let lib = root.join(name);
        std::fs::create_dir_all(&lib).unwrap();
        Device {
            lib: Dir(lib),
            base: root.join(format!("{name}-esitleme.json")),
            data: LocalData::default(),
        }
    }
    fn sync(&mut self, cloud: &Path, now: i64) -> SyncCounts {
        sync_core(cloud, &self.base, &mut self.lib, &mut self.data, now).unwrap()
    }
    fn write(&self, name: &str, text: &str) {
        std::fs::write(self.lib.0.join(name), text).unwrap();
    }
    fn read(&self, name: &str) -> Option<String> {
        std::fs::read_to_string(self.lib.0.join(name)).ok()
    }
    fn names(&self) -> Vec<String> {
        self.lib.list().into_keys().collect()
    }
}

fn setup(tag: &str) -> (PathBuf, PathBuf, Device, Device) {
    let root = std::env::temp_dir().join(format!("gpxer-sync-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let cloud = root.join("bulut").join(DIR);
    let a = Device::new(&root, "a");
    let b = Device::new(&root, "b");
    (root, cloud, a, b)
}

fn place(id: &str, name: &str) -> NamedPlace {
    NamedPlace {
        id: id.into(),
        name: name.into(),
        lat: 41.0,
        lon: 29.0,
        radius_m: 150.0,
        private: false,
    }
}

#[test]
fn records_and_data_flow_between_devices() {
    let (root, cloud, mut a, mut b) = setup("flow");
    a.write("x.gpx", "<gpx>x</gpx>");
    a.write("y.gpx", "<gpx>y</gpx>");
    a.data.meta.insert(
        "x.gpx".into(),
        FileMeta {
            tags: vec!["tatil".into()],
            ..Default::default()
        },
    );
    a.data.places.insert("ev".into(), place("ev", "Ev"));
    let c = a.sync(&cloud, 1);
    assert_eq!(c.pushed, 2);

    let c = b.sync(&cloud, 2);
    assert_eq!(c.pulled, 2);
    assert!(c.meta_changed && c.places_changed);
    assert_eq!(b.read("x.gpx").as_deref(), Some("<gpx>x</gpx>"));
    assert_eq!(b.data.meta["x.gpx"].tags, vec!["tatil".to_string()]);
    assert_eq!(b.data.places["ev"].name, "Ev");

    // A düzenler, B siler; ardından iki taraf da eşitlenir.
    a.write("x.gpx", "<gpx>x2</gpx>");
    std::fs::remove_file(b.lib.0.join("y.gpx")).unwrap();
    b.data.places.get_mut("ev").unwrap().name = "Evim".into();
    let ca = a.sync(&cloud, 3);
    assert_eq!(ca.pushed, 1);
    let cb = b.sync(&cloud, 4);
    assert_eq!((cb.pulled, cb.removed_remote), (1, 1));
    assert_eq!(b.read("x.gpx").as_deref(), Some("<gpx>x2</gpx>"));
    let ca = a.sync(&cloud, 5);
    assert_eq!(ca.removed_local, 1);
    assert_eq!(a.names(), vec!["x.gpx"]);
    assert_eq!(a.data.places["ev"].name, "Evim");

    // Kararlı: değişiklik yoksa iki taraf da bir şey yapmaz.
    for _ in 0..2 {
        assert_eq!(a.sync(&cloud, 6), SyncCounts::default());
        assert_eq!(b.sync(&cloud, 7), SyncCounts::default());
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn lost_state_file_never_deletes() {
    let (root, cloud, mut a, mut b) = setup("lost");
    a.write("x.gpx", "<gpx>x</gpx>");
    a.sync(&cloud, 1);
    b.sync(&cloud, 2);
    // Ortak durum dosyası kayboldu (bulut çakışması): kimse silinmez, yeniden yazılır.
    std::fs::remove_file(cloud.join(STATE)).unwrap();
    let c = a.sync(&cloud, 3);
    assert_eq!(c.removed_local, 0);
    assert_eq!(c.pushed, 1);
    let c = b.sync(&cloud, 4);
    assert_eq!((c.removed_local, c.pulled), (0, 0));
    assert_eq!(b.names(), vec!["x.gpx"]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn waits_for_files_not_yet_downloaded() {
    let (root, cloud, mut a, mut b) = setup("wait");
    a.write("x.gpx", "<gpx>x</gpx>");
    a.sync(&cloud, 1);
    // Bulut istemcisi dosyayı henüz indirmedi.
    let file = cloud.join(RECORDS).join("x.gpx");
    let bytes = std::fs::read(&file).unwrap();
    std::fs::remove_file(&file).unwrap();
    let c = b.sync(&cloud, 2);
    assert_eq!((c.pulled, c.waiting), (0, 1));
    std::fs::write(&file, bytes).unwrap();
    let c = b.sync(&cloud, 3);
    assert_eq!(c.pulled, 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn same_content_under_other_name_is_not_duplicated() {
    let (root, cloud, mut a, mut b) = setup("dup");
    a.write("a.gpx", "<gpx>aynı</gpx>");
    b.write("b.gpx", "<gpx>aynı</gpx>");
    a.sync(&cloud, 1);
    b.sync(&cloud, 2);
    a.sync(&cloud, 3);
    assert_eq!(a.names(), vec!["a.gpx"]);
    assert_eq!(b.names(), vec!["b.gpx"]);
    // Sonraki eşitlemelerde de silme ya da çekme döngüsü yok.
    for t in 4..8 {
        let c = if t % 2 == 0 {
            a.sync(&cloud, t)
        } else {
            b.sync(&cloud, t)
        };
        assert_eq!((c.pulled, c.removed_local, c.removed_remote), (0, 0, 0));
    }
    assert_eq!(a.names(), vec!["a.gpx"]);
    assert_eq!(b.names(), vec!["b.gpx"]);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn same_name_different_content_is_a_conflict() {
    let (root, cloud, mut a, mut b) = setup("conf");
    a.write("k.gpx", "<gpx>A</gpx>");
    b.write("k.gpx", "<gpx>B</gpx>");
    a.sync(&cloud, 1);
    let c = b.sync(&cloud, 2);
    assert_eq!(c.conflicts, vec!["k.gpx".to_string()]);
    assert_eq!(b.read("k.gpx").as_deref(), Some("<gpx>B</gpx>"));
    assert_eq!(a.read("k.gpx").as_deref(), Some("<gpx>A</gpx>"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rejects_unsafe_names() {
    assert!(safe_name("a.gpx"));
    assert!(!safe_name("../x.gpx"));
    assert!(!safe_name("a\\b.gpx"));
    assert!(!safe_name("notes.txt"));
}

#[test]
fn journal_notes_merge_between_devices() {
    let (root, cloud, mut a, mut b) = setup("journal");
    a.data
        .journal
        .insert("2024-07-09".into(), "Babamla Datça'ya gittik".into());
    a.sync(&cloud, 1);
    b.data.journal.insert("2024-07-10".into(), "Knidos".into());
    let c = b.sync(&cloud, 2);
    assert!(c.journal_changed);
    assert_eq!(b.data.journal["2024-07-09"], "Babamla Datça'ya gittik");
    // B'de silinen not A'da da silinir; A'nın gördüğü yeni not gelir.
    b.data.journal.remove("2024-07-09");
    b.sync(&cloud, 3);
    let c = a.sync(&cloud, 4);
    assert!(c.journal_changed);
    assert_eq!(
        a.data.journal.keys().collect::<Vec<_>>(),
        vec!["2024-07-10"]
    );
    let _ = std::fs::remove_dir_all(&root);
}
