//! Cihazlar arası eşitleme: kullanıcının seçtiği bulut klasörü (Drive, iCloud,
//! Dropbox, OneDrive…) üzerinden kayıtlar, kayıt bilgileri (etiket, not, tür),
//! adlandırılmış yerler ve yer imleri.
//!
//! Klasörde `GPXer-esitleme/kayitlar/` (GPX dosyaları) ve `durum.json` (her
//! öğenin son hali ve zamanı) bulunur. Her cihaz son eşitlemedeki durumu
//! (`esitleme.json`) saklar; üç yönlü karşılaştırmayla hangi tarafın neyi
//! değiştirdiği bulunur. Veri kaybına karşı:
//! - Bir kayıt öbür cihazda yalnızca açık bir silme işareti varsa silinir;
//!   durum dosyasında görünmeyen (henüz eşitlenmemiş, çakışan) kayıtlar silinmez.
//! - Bulut istemcisinin henüz indirmediği dosyalar sonraki eşitlemeye kalır.
//! - Aynı adla iki cihazda farklı içerik oluşmuşsa ikisine de dokunulmaz,
//!   çakışma olarak bildirilir.

use crate::bookmarks::{Bookmark, BookmarkStore};
use crate::library::{Library, LoadResult};
use crate::meta::{FileMeta, MetaStore};
use crate::places::{NamedPlace, PlacesStore};
use crate::run_blocking;
use crate::settings::SettingsStore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const VERSION: u32 = 1;
const DIR: &str = "GPXer-esitleme";
const RECORDS: &str = "kayitlar";
const STATE: &str = "durum.json";

/// Kararlı 64 bit özet (FNV-1a): Rust sürümünden bağımsız, cihazlar arasında aynı.
fn fnv(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

fn value_hash<T: Serialize>(v: &T) -> String {
    fnv(&serde_json::to_vec(v).unwrap_or_default())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct RemoteRecord {
    hash: String,
    t: i64,
    #[serde(default)]
    deleted: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct Stamped<T> {
    /// `None`: silindi.
    v: Option<T>,
    t: i64,
}

/// Klasördeki ortak durum.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
struct Remote {
    version: u32,
    records: BTreeMap<String, RemoteRecord>,
    meta: BTreeMap<String, Stamped<FileMeta>>,
    places: BTreeMap<String, Stamped<NamedPlace>>,
    bookmarks: BTreeMap<String, Stamped<Bookmark>>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct BaseRecord {
    hash: String,
    size: u64,
    mtime: i64,
    /// Yerelde bu adla duruyor mu. `false`: aynı içerik yerelde başka adla var
    /// (kopya); bu ad için ne çekilir ne silinir.
    present: bool,
}

/// Bu cihazın son eşitlemedeki durumu.
#[derive(Serialize, Deserialize, Default, Debug)]
#[serde(default)]
struct Base {
    /// Hangi klasörle eşitlendi (klasör değişince sıfırdan başlanır).
    folder: String,
    records: BTreeMap<String, BaseRecord>,
    meta: BTreeMap<String, String>,
    places: BTreeMap<String, String>,
    bookmarks: BTreeMap<String, String>,
    last: i64,
}

/// Yerel kütüphaneye uygulanan işlemler (uygulamada [`Library`], testte klasör).
pub(crate) trait LocalRecords {
    /// Yereldeki kayıtlar: ad → (yol, boyut, değiştirilme zamanı).
    fn list(&self) -> BTreeMap<String, (PathBuf, u64, i64)>;
    /// Tek kaydın boyutu ve değiştirilme zamanı.
    fn stat(&self, name: &str) -> Option<(u64, i64)>;
    /// Yeni kayıt ekler; aynı içerik yerelde zaten varsa `false`.
    fn add(&mut self, name: &str, bytes: &[u8]) -> Result<bool, String>;
    /// Var olan kaydın içeriğini değiştirir.
    fn replace(&mut self, name: &str, bytes: &[u8]) -> Result<(), String>;
    /// Kaydı kaldırır (uygulamada çöp kutusuna).
    fn remove(&mut self, name: &str) -> Result<(), String>;
}

/// Kayıt dışı veriler (bilgiler, yerler, yer imleri) yerelde.
#[derive(Default, Debug, PartialEq)]
pub(crate) struct LocalData {
    /// Kayıt adı → bilgileri (yalnızca yereldeki kayıtlar).
    pub meta: BTreeMap<String, FileMeta>,
    pub places: BTreeMap<String, NamedPlace>,
    pub bookmarks: BTreeMap<String, Bookmark>,
}

#[derive(Serialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncCounts {
    pub pushed: usize,
    pub pulled: usize,
    pub removed_local: usize,
    pub removed_remote: usize,
    pub conflicts: Vec<String>,
    pub waiting: usize,
    pub meta_changed: bool,
    pub places_changed: bool,
    pub bookmarks_changed: bool,
}

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
    match std::fs::read(path) {
        Ok(b) => {
            serde_json::from_slice(&b).map_err(|e| format!("{} okunamadı: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("{} okunamadı: {e}", path.display())),
    }
}

fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(v).map_err(|e| e.to_string())?;
    crate::store::write_atomic(path, &bytes)
        .map_err(|e| format!("{} yazılamadı: {e}", path.display()))
}

/// Ad bir kayıt dosyası adı mı (klasör dışına çıkamaz).
fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
        && Path::new(name)
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("gpx"))
}

/// Bilgi, yer ve yer imleri için üç yönlü birleştirme. Yerel değişiklik ve
/// uzaktaki değişiklik çakışırsa yerel kazanır (zamanı eşitleme anı).
/// `applicable`: uzaktaki öğe yerelde uygulanabilir mi (bilgiler için kayıt yerelde var mı).
fn merge_values<T: Serialize + Clone>(
    local: &mut BTreeMap<String, T>,
    base: &mut BTreeMap<String, String>,
    remote: &mut BTreeMap<String, Stamped<T>>,
    now: i64,
    applicable: impl Fn(&str) -> bool,
) -> (bool, bool) {
    let keys: BTreeSet<String> = local
        .keys()
        .chain(base.keys())
        .chain(remote.keys())
        .cloned()
        .collect();
    let (mut local_changed, mut remote_changed) = (false, false);
    for k in keys {
        let lh = local.get(&k).map(value_hash);
        let bh = base.get(&k).cloned();
        let r = remote.get(&k);
        let rh = r.and_then(|r| r.v.as_ref().map(value_hash));
        let l_changed = lh != bh;
        // Uzakta hiç olmayan öğe "değişmedi" sayılır (silme değil).
        let r_changed = r.is_some() && rh != bh;
        if l_changed {
            if lh == rh && r.is_some() {
                // İki taraf aynı sonuca varmış.
            } else {
                remote.insert(
                    k.clone(),
                    Stamped {
                        v: local.get(&k).cloned(),
                        t: now,
                    },
                );
                remote_changed = true;
            }
            match lh {
                Some(h) => base.insert(k, h),
                None => base.remove(&k),
            };
        } else if r_changed {
            if !applicable(&k) {
                continue;
            }
            match r.and_then(|r| r.v.clone()) {
                Some(v) => {
                    local.insert(k.clone(), v);
                }
                None => {
                    local.remove(&k);
                }
            }
            local_changed = true;
            match rh {
                Some(h) => base.insert(k, h),
                None => base.remove(&k),
            };
        } else if r.is_none() && lh.is_some() {
            // Uzakta kaybolmuş (durum dosyası başka cihazca ezilmiş): yeniden yaz.
            remote.insert(
                k.clone(),
                Stamped {
                    v: local.get(&k).cloned(),
                    t: now,
                },
            );
            remote_changed = true;
        }
    }
    (local_changed, remote_changed)
}

/// Çekilen kaydı bu cihazın durumuna yazar (yereldeki boyut ve zamanla).
fn record_base(local: &dyn LocalRecords, base: &mut Base, name: &str, hash: &str, present: bool) {
    let (size, mtime) = local.stat(name).unwrap_or((0, 0));
    base.records.insert(
        name.to_owned(),
        BaseRecord {
            hash: hash.to_owned(),
            size,
            mtime,
            present,
        },
    );
}

/// Eşitlemenin çekirdeği: `root` klasördeki ortak alan, `base_path` bu cihazın durumu.
pub(crate) fn sync_core(
    root: &Path,
    base_path: &Path,
    local: &mut dyn LocalRecords,
    data: &mut LocalData,
    now: i64,
) -> Result<SyncCounts, String> {
    let rec_dir = root.join(RECORDS);
    std::fs::create_dir_all(&rec_dir)
        .map_err(|e| format!("Eşitleme klasörü oluşturulamadı: {e}"))?;
    let state_path = root.join(STATE);
    let mut remote: Remote = read_json(&state_path)?;
    if remote.version > VERSION {
        return Err(
            "Eşitleme klasörü GPXer'in daha yeni bir sürümüyle oluşturulmuş; önce güncelleyin"
                .into(),
        );
    }
    remote.version = VERSION;
    let mut base: Base = read_json(base_path)?;
    let folder = root.to_string_lossy().into_owned();
    if base.folder != folder {
        // Başka bir klasörle eşitleniyordu: geçmiş geçersiz (silme yapılmaz).
        base = Base {
            folder,
            ..Default::default()
        };
    }
    let mut c = SyncCounts::default();

    // ---------- Kayıtlar ----------
    let files = local.list();
    let hash_of = |name: &str, path: &Path, size: u64, mtime: i64, base: &Base| -> Option<String> {
        match base.records.get(name) {
            Some(b) if b.present && b.size == size && b.mtime == mtime => Some(b.hash.clone()),
            _ => std::fs::read(path).ok().map(|b| fnv(&b)),
        }
    };
    let names: BTreeSet<String> = files
        .keys()
        .chain(base.records.keys())
        .chain(remote.records.keys())
        .cloned()
        .collect();
    let remote_file = |name: &str| rec_dir.join(name);
    for name in names {
        if !safe_name(&name) {
            continue;
        }
        let l = files.get(&name).and_then(|(p, size, mtime)| {
            hash_of(&name, p, *size, *mtime, &base).map(|h| (h, *size, *mtime, p.clone()))
        });
        let b = base.records.get(&name).cloned();
        let r = remote.records.get(&name).cloned();
        let r_live = r.as_ref().filter(|r| !r.deleted);
        let push = |c: &mut SyncCounts,
                    remote: &mut Remote,
                    path: &Path,
                    hash: &str|
         -> Result<(), String> {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            crate::store::write_atomic(&remote_file(&name), &bytes)
                .map_err(|e| format!("{name} gönderilemedi: {e}"))?;
            remote.records.insert(
                name.clone(),
                RemoteRecord {
                    hash: hash.to_owned(),
                    t: now,
                    deleted: false,
                },
            );
            c.pushed += 1;
            Ok(())
        };
        // Uzaktaki dosya: indirilmemişse ya da içeriği durumla uyuşmuyorsa (yazılıyor) bekle.
        let fetch = |r: &RemoteRecord| -> Option<Vec<u8>> {
            let bytes = std::fs::read(remote_file(&name)).ok()?;
            (fnv(&bytes) == r.hash).then_some(bytes)
        };
        match (l, b.filter(|b| b.present)) {
            (Some((lh, size, mtime, path)), None) => {
                // Yerelde yeni (ya da önceden kopya sayılan ad şimdi yerelde var).
                match r_live {
                    Some(r) if r.hash == lh => {}
                    Some(_) => {
                        c.conflicts.push(name.clone());
                        continue;
                    }
                    None => push(&mut c, &mut remote, &path, &lh)?,
                }
                base.records.insert(
                    name.clone(),
                    BaseRecord {
                        hash: lh,
                        size,
                        mtime,
                        present: true,
                    },
                );
            }
            (Some((lh, size, mtime, path)), Some(b)) => {
                let changed = lh != b.hash;
                match r.as_ref() {
                    // Öbür cihaz bu içeriği sildi; burada değişmemiş: sil.
                    Some(r) if r.deleted && !changed && r.hash == b.hash => {
                        local.remove(&name)?;
                        base.records.remove(&name);
                        c.removed_local += 1;
                        continue;
                    }
                    Some(r) if !r.deleted && r.hash != b.hash && !changed => {
                        // Uzakta düzenlenmiş, burada değişmemiş: çek.
                        let Some(bytes) = fetch(r) else {
                            c.waiting += 1;
                            continue;
                        };
                        local.replace(&name, &bytes)?;
                        c.pulled += 1;
                        let hash = r.hash.clone();
                        record_base(&*local, &mut base, &name, &hash, true);
                        continue;
                    }
                    Some(r) if !r.deleted && r.hash == lh => {}
                    Some(r) if !r.deleted && r.hash != b.hash && changed => {
                        // İki tarafta da değişmiş: bu cihazdaki kazanır.
                        c.conflicts.push(name.clone());
                        push(&mut c, &mut remote, &path, &lh)?;
                    }
                    _ if changed || r_live.is_none() => push(&mut c, &mut remote, &path, &lh)?,
                    _ => {}
                }
                base.records.insert(
                    name.clone(),
                    BaseRecord {
                        hash: lh,
                        size,
                        mtime,
                        present: true,
                    },
                );
            }
            (None, Some(b)) => {
                // Burada silinmiş.
                match r_live {
                    Some(r) if r.hash == b.hash => {
                        let _ = std::fs::remove_file(remote_file(&name));
                        remote.records.insert(
                            name.clone(),
                            RemoteRecord {
                                hash: b.hash.clone(),
                                t: now,
                                deleted: true,
                            },
                        );
                        c.removed_remote += 1;
                        base.records.remove(&name);
                    }
                    Some(r) => {
                        // Öbür cihazda düzenlenmiş: düzenleme silmeye üstün, geri gelir.
                        let Some(bytes) = fetch(r) else {
                            c.waiting += 1;
                            continue;
                        };
                        let added = local.add(&name, &bytes)?;
                        c.pulled += added as usize;
                        let hash = r.hash.clone();
                        record_base(&*local, &mut base, &name, &hash, added);
                    }
                    None => {
                        base.records.remove(&name);
                    }
                }
            }
            (None, None) => {
                // Yerelde yok; daha önce görülmemiş ya da kopya sayılmış.
                let b = base.records.get(&name).cloned();
                match r_live {
                    Some(r) if b.as_ref().is_some_and(|b| b.hash == r.hash) => {}
                    Some(r) => {
                        let Some(bytes) = fetch(r) else {
                            c.waiting += 1;
                            continue;
                        };
                        let added = local.add(&name, &bytes)?;
                        c.pulled += added as usize;
                        let hash = r.hash.clone();
                        record_base(&*local, &mut base, &name, &hash, added);
                    }
                    None => {
                        base.records.remove(&name);
                    }
                }
            }
        }
    }

    // ---------- Bilgiler, yerler, yer imleri ----------
    let present: BTreeSet<String> = local.list().into_keys().collect();
    let (lc, rc) = merge_values(&mut data.meta, &mut base.meta, &mut remote.meta, now, |k| {
        present.contains(k)
    });
    c.meta_changed = lc;
    let mut remote_changed = rc;
    let (lc, rc) = merge_values(
        &mut data.places,
        &mut base.places,
        &mut remote.places,
        now,
        |_| true,
    );
    c.places_changed = lc;
    remote_changed |= rc;
    let (lc, rc) = merge_values(
        &mut data.bookmarks,
        &mut base.bookmarks,
        &mut remote.bookmarks,
        now,
        |_| true,
    );
    c.bookmarks_changed = lc;
    remote_changed |= rc;

    if remote_changed || c.pushed > 0 || c.removed_remote > 0 || !state_path.exists() {
        write_json(&state_path, &remote)?;
    }
    base.last = now;
    write_json(base_path, &base)?;
    Ok(c)
}

/// Dosyanın boyutu ve değiştirilme zamanı (ms).
pub(crate) fn file_stat(path: &Path) -> Option<(u64, i64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    Some((meta.len(), mtime))
}

// ---------- Uygulama tarafı ----------

/// Kütüphane üzerinde kayıt işlemleri; eklenen/değişen/kaldırılan kayıtlar arayüze bildirilir.
struct AppRecords<'a> {
    app: &'a AppHandle,
    added: Vec<LoadResult>,
    updated: Vec<LoadResult>,
    removed: Vec<String>,
}

impl AppRecords<'_> {
    fn library(&self) -> tauri::State<'_, Library> {
        self.app.state::<Library>()
    }
    fn load(&self, path: &Path) -> LoadResult {
        let cfg = self.app.state::<SettingsStore>().stats();
        let p = path.to_string_lossy().into_owned();
        let chosen = self.app.state::<MetaStore>().activity(&p);
        self.library().load(p, &cfg, chosen)
    }
}

impl LocalRecords for AppRecords<'_> {
    fn list(&self) -> BTreeMap<String, (PathBuf, u64, i64)> {
        self.library()
            .files()
            .into_iter()
            .filter_map(|p| {
                let path = PathBuf::from(&p);
                let (size, mtime) = file_stat(&path)?;
                Some((
                    path.file_name()?.to_string_lossy().into_owned(),
                    (path, size, mtime),
                ))
            })
            .collect()
    }

    fn stat(&self, name: &str) -> Option<(u64, i64)> {
        file_stat(&self.library().dir.join(name))
    }

    fn add(&mut self, name: &str, bytes: &[u8]) -> Result<bool, String> {
        let path = self.library().dir.join(name);
        if path.exists() {
            return Ok(false);
        }
        crate::store::write_atomic(&path, bytes).map_err(|e| format!("{name} alınamadı: {e}"))?;
        match self.load(&path) {
            r @ LoadResult::Ok { .. } => {
                self.added.push(r);
                Ok(true)
            }
            _ => {
                // Aynı içerik başka adla var (ya da okunamadı): eklenmez.
                let _ = std::fs::remove_file(&path);
                Ok(false)
            }
        }
    }

    fn replace(&mut self, name: &str, bytes: &[u8]) -> Result<(), String> {
        let path = self.library().dir.join(name);
        crate::store::write_atomic(&path, bytes)
            .map_err(|e| format!("{name} güncellenemedi: {e}"))?;
        let r = self.load(&path);
        self.updated.push(r);
        Ok(())
    }

    fn remove(&mut self, name: &str) -> Result<(), String> {
        let p = self.library().dir.join(name).to_string_lossy().into_owned();
        self.library().trash(std::slice::from_ref(&p))?;
        self.removed.push(p);
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncReport {
    #[serde(flatten)]
    counts: SyncCounts,
    /// Bu eşitlemede eklenen ve içeriği değişen kayıtlar (arayüz listeye alır).
    added: Vec<LoadResult>,
    updated: Vec<LoadResult>,
    /// Çöp kutusuna taşınan kayıtlar.
    removed: Vec<String>,
    at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncInfo {
    folder: Option<String>,
    last: Option<i64>,
}

fn base_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("esitleme.json"))
}

/// Eşitleme klasörü ve son eşitleme zamanı.
#[tauri::command]
pub(crate) fn sync_info(app: AppHandle) -> SyncInfo {
    let folder = app
        .state::<SettingsStore>()
        .current
        .lock()
        .unwrap()
        .sync_folder
        .clone();
    let last = base_path(&app)
        .ok()
        .and_then(|p| read_json::<Base>(&p).ok())
        .filter(|b| b.last > 0)
        .map(|b| b.last);
    SyncInfo { folder, last }
}

/// Seçili klasörle şimdi eşitler.
#[tauri::command]
pub(crate) async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    static RUNNING: Mutex<()> = Mutex::new(());
    run_blocking(move || {
        let Ok(_one) = RUNNING.try_lock() else {
            return Err("Eşitleme zaten sürüyor".into());
        };
        let folder = app
            .state::<SettingsStore>()
            .current
            .lock()
            .unwrap()
            .sync_folder
            .clone()
            .ok_or("Eşitleme klasörü seçilmemiş (Ayarlar → Eşitleme)")?;
        if !Path::new(&folder).is_dir() {
            return Err(format!("Eşitleme klasörü bulunamadı: {folder}"));
        }
        let root = Path::new(&folder).join(DIR);
        let library_dir = app.state::<Library>().dir.clone();
        // Yereldeki bilgiler kayıt adına göre.
        let meta_all = app.state::<MetaStore>().all();
        let mut data = LocalData {
            meta: meta_all
                .iter()
                .filter(|(p, _)| Path::new(p).parent() == Some(library_dir.as_path()))
                .filter_map(|(p, m)| {
                    Some((
                        Path::new(p).file_name()?.to_string_lossy().into_owned(),
                        m.clone(),
                    ))
                })
                .collect(),
            places: app
                .state::<PlacesStore>()
                .all()
                .into_iter()
                .map(|p| (p.id.clone(), p))
                .collect(),
            bookmarks: app
                .state::<BookmarkStore>()
                .all()
                .into_iter()
                .map(|b| (b.id.clone(), b))
                .collect(),
        };
        let before_meta = data.meta.clone();
        let mut records = AppRecords {
            app: &app,
            added: Vec::new(),
            updated: Vec::new(),
            removed: Vec::new(),
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let counts = sync_core(&root, &base_path(&app)?, &mut records, &mut data, now)?;
        let (added, updated, removed) = (records.added, records.updated, records.removed);
        let _ = app.state::<Library>().flush_cache();
        if counts.meta_changed {
            let mut items: HashMap<String, FileMeta> = HashMap::new();
            for (name, m) in &data.meta {
                if before_meta.get(name) != Some(m) {
                    items.insert(
                        library_dir.join(name).to_string_lossy().into_owned(),
                        m.clone(),
                    );
                }
            }
            for name in before_meta.keys().filter(|n| !data.meta.contains_key(*n)) {
                items.insert(
                    library_dir.join(name).to_string_lossy().into_owned(),
                    FileMeta::default(),
                );
            }
            app.state::<MetaStore>()
                .set_many(items.into_iter().collect())
                .map_err(|e| format!("Kayıt bilgileri yazılamadı: {e}"))?;
        }
        if counts.places_changed {
            app.state::<PlacesStore>()
                .set(data.places.into_values().collect())
                .map_err(|e| format!("Yerler yazılamadı: {e}"))?;
        }
        if counts.bookmarks_changed {
            let mut list: Vec<Bookmark> = data.bookmarks.into_values().collect();
            list.sort_by_key(|b| b.created);
            app.state::<BookmarkStore>()
                .set(list)
                .map_err(|e| format!("Yer imleri yazılamadı: {e}"))?;
        }
        Ok(SyncReport {
            counts,
            added,
            updated,
            removed,
            at: now,
        })
    })
    .await?
}

#[cfg(test)]
mod tests;
