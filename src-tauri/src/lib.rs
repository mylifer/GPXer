mod backup;
mod dem;
mod edit;
mod export;
mod geo;
mod library;
mod links;
mod menu;
mod meta;
mod photos;
mod places;
mod rewrite;
mod settings;
mod snap;
mod store;
mod weather;

use gpx_core::{Detail, Stats};
use library::{is_track_file, Library, LoadResult, TrashItem};
use meta::{FileMeta, MetaStore};
use places::{NamedPlace, PlacesStore};
use rayon::prelude::*;
use settings::{Settings, SettingsStore};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// İşletim sisteminden gelen (çift tıklama, "Birlikte aç", ikinci örnek)
/// ama arayüzün henüz almadığı dosya yolları.
#[derive(Default)]
struct PendingPaths(Mutex<Vec<String>>);

fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> impl std::future::Future<Output = Result<T, String>> {
    let handle = tauri::async_runtime::spawn_blocking(f);
    async move { handle.await.map_err(|e| e.to_string()) }
}

/// Klasörleri özyinelemeli olarak tarar ve içindeki .gpx dosyalarını,
/// doğrudan verilen dosyalarla birlikte tekilleştirilmiş bir listede döndürür.
#[tauri::command]
async fn expand_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let mut out: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for p in paths {
            let path = PathBuf::from(&p);
            if path.is_dir() {
                let mut found: Vec<String> = walkdir::WalkDir::new(&path)
                    .follow_links(true)
                    .into_iter()
                    .filter_map(Result::ok)
                    .filter(|e| e.file_type().is_file() && is_track_file(e.path()))
                    .map(|e| e.path().to_string_lossy().into_owned())
                    .collect();
                found.sort();
                for f in found {
                    if seen.insert(f.clone()) {
                        out.push(f);
                    }
                }
            } else if path.is_file() && seen.insert(p.clone()) {
                out.push(p);
            }
        }
        out
    })
    .await
}

/// Dosyaları paralel olarak okuyup özetler ve kütüphaneye ekler. Değişmemiş
/// dosyaların özeti önbellekten gelir. `explicit` kullanıcının dosyayı kendisi
/// açtığını (Dosya Aç, Klasör Aç, sürükle-bırak, çift tıklama) belirtir.
/// Kullanıcının sildiği kayıtlar yalnızca kendiliğinden yüklemelerde
/// (açılışta, izlenen klasörden) yeniden eklenmez; elle açılırsa eklenir ve
/// silinenlerden çıkarılır.
#[tauri::command]
async fn load_files(
    app: AppHandle,
    paths: Vec<String>,
    explicit: Option<bool>,
) -> Result<Vec<LoadResult>, String> {
    let explicit = explicit.unwrap_or(false);
    run_blocking(move || load_many(&app, paths, explicit)).await
}

/// [`load_files`]'ın işi (yedekten geri yükleme de kullanır).
pub(crate) fn load_many(app: &AppHandle, paths: Vec<String>, explicit: bool) -> Vec<LoadResult> {
    {
        let library = app.state::<Library>();
        let meta = app.state::<MetaStore>();
        let settings = app.state::<SettingsStore>();
        let cfg = settings.stats();
        let parsed: Vec<_> = paths
            .into_par_iter()
            .map(|p| {
                // Daha önce görülmüş, değişmemiş dış dosyanın kopyası: okunmaz.
                if let Some(r) = library.quick_duplicate(&p, explicit) {
                    return (p, None, Err(r));
                }
                let chosen = meta.activity(&p);
                // Ayrıştırıcıda beklenmeyen bir çökme yalnızca o dosyayı
                // hatalı sayar; partideki diğer dosyalar yüklenir.
                let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    library.summarize(&p, &cfg, chosen)
                }))
                .unwrap_or_else(|_| {
                    Err(library::SummaryError::Failed(
                        "Dosya okunurken beklenmeyen bir hata oluştu".into(),
                    ))
                });
                (p, chosen, Ok(res))
            })
            .collect();
        // Kopya denetimi sırayla yapılır ki aynı partide gelen iki kopya da
        // yakalansın.
        parsed
            .into_iter()
            .map(|(p, chosen, res)| match res {
                Err(quick) => quick,
                Ok(res) => match res {
                    Ok((_, fp)) if library.blocks(fp, &p, explicit) => LoadResult::Duplicate {
                        existing: p.clone(),
                        path: p,
                    },
                    Ok((file, fp)) => {
                        if explicit {
                            library.undismiss(fp);
                        }
                        library.add(p, file, fp, &cfg, chosen)
                    }
                    Err(e) => e.into_result(p),
                },
            })
            .collect()
    }
}

/// Özet önbelleğini diske yazar (bir yükleme bittiğinde çağrılır).
#[tauri::command]
async fn flush_cache(app: AppHandle) -> Result<(), String> {
    run_blocking(move || {
        app.state::<Library>()
            .flush_cache()
            .map_err(|e| e.to_string())
    })
    .await?
}

/// Kütüphanedeki dosyaların yolları.
#[tauri::command]
fn library_files(library: tauri::State<'_, Library>) -> Vec<String> {
    library.files()
}

/// Dosyaları kütüphaneden çöp kutusuna taşır; geri almak için gereken
/// bilgiyi döndürür. Bilgileri (etiket, not, tür) çöp kutusundaki yola taşınır.
#[tauri::command]
async fn remove_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<TrashItem>, String> {
    run_blocking(move || {
        let items = app.state::<Library>().trash(&paths)?;
        let meta = app.state::<MetaStore>();
        for it in &items {
            meta.rename(&it.original, &it.trashed);
        }
        Ok(items)
    })
    .await?
}

/// Çöp kutusuna taşınan dosyaları geri getirir; yeni yollarını döndürür.
#[tauri::command]
async fn restore_files(app: AppHandle, items: Vec<TrashItem>) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let meta = app.state::<MetaStore>();
        app.state::<Library>()
            .restore(&items)
            .into_iter()
            .map(|(trashed, new)| {
                meta.rename(&trashed, &new);
                new
            })
            .collect()
    })
    .await
}

#[tauri::command]
async fn load_detail(app: AppHandle, path: String) -> Result<Detail, String> {
    run_blocking(move || {
        let cfg = app.state::<SettingsStore>().stats();
        let p = prepared(&app, &path, &cfg)?;
        Ok(gpx_core::build_detail(&p.gpx))
    })
    .await?
}

/// Etiket, not ve tür bilgilerinin tamamı (kütüphane yoluna göre).
#[tauri::command]
fn get_meta(meta: tauri::State<'_, MetaStore>) -> std::collections::HashMap<String, FileMeta> {
    meta.all()
}

/// Kaydın bilgilerini kaydeder. Tür değiştiyse istatistikler o türe göre
/// yeniden hesaplanır ve yeni özet döndürülür.
#[tauri::command]
async fn set_meta(
    app: AppHandle,
    path: String,
    value: FileMeta,
) -> Result<Option<LoadResult>, String> {
    run_blocking(move || {
        app.state::<Library>().check(&path)?;
        let chosen = value.activity;
        let old = app
            .state::<MetaStore>()
            .set(&path, value)
            .map_err(|e| e.to_string())?;
        if old.activity == chosen {
            return Ok(None);
        }
        let cfg = app.state::<SettingsStore>().stats();
        let res = app.state::<Library>().load(path, &cfg, chosen);
        let _ = app.state::<Library>().flush_cache();
        Ok(Some(res))
    })
    .await?
}

/// Seçili kayıtlara tek seferde etiket ekler; değişen kayıtların bilgilerini
/// döndürür.
#[tauri::command]
async fn add_tag(
    app: AppHandle,
    paths: Vec<String>,
    tag: String,
) -> Result<std::collections::HashMap<String, FileMeta>, String> {
    run_blocking(move || {
        let library = app.state::<Library>();
        let paths: Vec<String> = paths
            .into_iter()
            .filter(|p| library.check(p).is_ok())
            .collect();
        app.state::<MetaStore>()
            .add_tag(&paths, &tag)
            .map_err(|e| e.to_string())
    })
    .await?
}

/// Asıl noktaların `[start, end]` aralığının tam çözünürlüklü istatistiği.
#[tauri::command]
async fn range_stats(
    app: AppHandle,
    path: String,
    start: usize,
    end: usize,
) -> Result<Stats, String> {
    run_blocking(move || {
        let cfg = app.state::<SettingsStore>().stats();
        let chosen = app.state::<MetaStore>().activity(&path);
        let p = prepared(&app, &path, &cfg)?;
        let (eff, _) = gpx_core::effective_config(&p.gpx, &cfg, chosen);
        Ok(gpx_core::range_stats(&p.gpx, start, end, &eff))
    })
    .await?
}

/// Kütüphanedeki kaydın ayarlara göre hazırlanmış (sıçramaları ayıklanmış)
/// hali; grafikteki nokta sıraları bu hale göredir. Son kullanılanlar
/// bellekte tutulur.
fn prepared(
    app: &AppHandle,
    path: &str,
    cfg: &gpx_core::StatsConfig,
) -> Result<std::sync::Arc<gpx_core::Prepared>, String> {
    let library = app.state::<Library>();
    library.check(path)?;
    library.prepared(path, cfg)
}

/// Kütüphanedeki kaydın ham (temizlenmemiş) hali.
fn read_raw(app: &AppHandle, path: &str) -> Result<gpx_core::parse::Gpx, String> {
    app.state::<Library>().check(path)?;
    gpx_core::read_gpx_file(Path::new(path))
        .map(|(g, _)| g)
        .map_err(|e| e.to_string())
}

/// Hazırlanmış kayıttaki nokta sırasını ham kayıttaki sıraya çevirir.
fn raw_index(p: &gpx_core::Prepared, i: usize) -> Result<usize, String> {
    p.raw_index(i).ok_or_else(|| "Geçersiz nokta".to_owned())
}

/// Adlandırılmış yerler.
#[tauri::command]
fn get_places(store: tauri::State<'_, PlacesStore>) -> Vec<NamedPlace> {
    store.all()
}

#[tauri::command]
async fn set_places(app: AppHandle, places: Vec<NamedPlace>) -> Result<(), String> {
    run_blocking(move || {
        app.state::<PlacesStore>()
            .set(places)
            .map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
fn get_settings(store: tauri::State<'_, SettingsStore>) -> Settings {
    store.current.lock().unwrap().clone()
}

/// Ayarları kaydeder ve klasör izleyicisini yeniden kurar. İzlenemeyen
/// klasörlerin hata mesajları döndürülür.
#[tauri::command]
async fn set_settings(app: AppHandle, settings: Settings) -> Result<Vec<String>, String> {
    run_blocking(move || {
        let store = app.state::<SettingsStore>();
        store.save(settings).map_err(|e| e.to_string())?;
        Ok(start_watcher(&app))
    })
    .await?
}

fn start_watcher(app: &AppHandle) -> Vec<String> {
    let handle = app.clone();
    app.state::<SettingsStore>().restart_watcher(move |paths| {
        // İzlenen klasörden gelenler sessizce eklenir; pencere öne alınmaz.
        let _ = handle.emit("watched-paths", paths);
    })
}

#[tauri::command]
fn take_pending_paths(state: tauri::State<'_, PendingPaths>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

fn queue_paths(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<PendingPaths>().0.lock().unwrap().extend(paths);
    let _ = app.emit("pending-paths", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Komut satırı argümanlarından (Windows/Linux'ta dosya ilişkilendirmesi bu
/// yolla gelir) var olan dosya/klasör yollarını ayıklar.
fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: Option<&Path>) -> Vec<String> {
    args.into_iter()
        .filter_map(|a| {
            let p = PathBuf::from(&a);
            let p = match (p.is_absolute(), cwd) {
                (false, Some(cwd)) => cwd.join(p),
                _ => p,
            };
            // "-" ile başlayan seçenekler atlanır; aynı adlı gerçek dosya değil.
            p.exists().then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Uygulama zaten açıkken çift tıklanan dosyalar yeni pencere yerine
        // mevcut pencereye gönderilir.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = paths_from_args(argv.into_iter().skip(1), Some(Path::new(&cwd)));
            queue_paths(app, paths);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .manage(PendingPaths::default())
        .manage(export::ApprovedPaths::default())
        .manage(photos::PhotoPaths::default())
        .setup(|app| {
            let handle = app.handle();
            let root = app.path().app_data_dir()?;
            let library = Library::open(&root)?;
            let meta = MetaStore::open(&root);
            // Kalıcı silinen çöp dosyalarının bilgileri atılır.
            meta.prune(&library.trash_dir);
            app.manage(library);
            app.manage(SettingsStore::open(&root));
            app.manage(meta);
            app.manage(PlacesStore::open(&root));
            app.set_menu(menu::build_menu(handle)?)?;
            // Büyük ya da ağdaki klasörü izlemeye almak saniyeler sürebilir;
            // pencere beklemesin.
            let h = handle.clone();
            std::thread::spawn(move || {
                for e in start_watcher(&h) {
                    eprintln!("{e}");
                }
            });
            // Göreli yollar (terminalden "gpxer iz.gpx") mutlak yola çevrilir.
            let cwd = std::env::current_dir().ok();
            let initial = paths_from_args(std::env::args().skip(1), cwd.as_deref());
            app.state::<PendingPaths>()
                .0
                .lock()
                .unwrap()
                .extend(initial);
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            expand_paths,
            load_files,
            load_detail,
            add_tag,
            backup::backup_library,
            backup::restore_library,
            dem::fix_elevation,
            rewrite::undo_rewrite,
            snap::snap_to_roads,
            links::open_street_view,
            weather::weather_at,
            take_pending_paths,
            library_files,
            remove_files,
            restore_files,
            flush_cache,
            range_stats,
            edit::trim_file,
            edit::split_file,
            edit::merge_files,
            export::export_as,
            export::export_many,
            export::pick_save_path,
            get_meta,
            set_meta,
            export::write_text_file,
            export::write_base64_file,
            get_settings,
            set_settings,
            photos::read_photos,
            photos::photo_thumb,
            get_places,
            set_places
        ])
        .build(tauri::generate_context!())
        .expect("uygulama başlatılamadı");

    app.run(|_app, _event| {
        // macOS dosya ilişkilendirmesi argüman yerine bu olayla gelir.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            queue_paths(_app, paths);
        }
    });
}
