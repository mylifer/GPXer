mod library;
mod meta;
mod settings;

use base64::Engine;
use gpx_core::{Detail, Stats};
use library::{is_track_file, Library, LoadResult, TrashItem};
use meta::{FileMeta, MetaStore};
use rayon::prelude::*;
use settings::{Settings, SettingsStore};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
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
/// dosyaların özeti önbellekten gelir.
#[tauri::command]
async fn load_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<LoadResult>, String> {
    run_blocking(move || {
        let library = app.state::<Library>();
        let meta = app.state::<MetaStore>();
        let cfg = app.state::<SettingsStore>().stats();
        let parsed: Vec<_> = paths
            .into_par_iter()
            .map(|p| {
                let chosen = meta.activity(&p);
                let res = library.summarize(&p, &cfg, chosen);
                (p, chosen, res)
            })
            .collect();
        // Kopya denetimi sırayla yapılır ki aynı partide gelen iki kopya da
        // yakalansın.
        parsed
            .into_iter()
            .map(|(p, chosen, res)| match res {
                Ok((file, fp)) => library.add(p, file, fp, &cfg, chosen),
                Err(message) => LoadResult::Error { path: p, message },
            })
            .collect()
    })
    .await
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
/// bilgiyi döndürür.
#[tauri::command]
fn remove_files(
    library: tauri::State<'_, Library>,
    paths: Vec<String>,
) -> Result<Vec<TrashItem>, String> {
    library.trash(&paths)
}

/// Çöp kutusuna taşınan dosyaları geri getirir; yeni yollarını döndürür.
#[tauri::command]
fn restore_files(
    library: tauri::State<'_, Library>,
    meta: tauri::State<'_, MetaStore>,
    items: Vec<TrashItem>,
) -> Vec<String> {
    library
        .restore(&items)
        .into_iter()
        .map(|(old, new)| {
            if old != new {
                meta.rename(&old, &new);
            }
            new
        })
        .collect()
}

#[tauri::command]
async fn load_detail(app: AppHandle, path: String) -> Result<Detail, String> {
    run_blocking(move || {
        let cfg = app.state::<SettingsStore>().stats();
        gpx_core::load_detail(Path::new(&path), &cfg).map_err(|e| e.to_string())
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
        let gpx = read(&app, &path)?;
        let (eff, _) = gpx_core::effective_config(&gpx, &cfg, chosen);
        Ok(gpx_core::range_stats(&gpx, start, end, &eff))
    })
    .await?
}

/// Kaydı ayarlara göre hazırlanmış (sıçramaları ayıklanmış) haliyle okur;
/// grafikteki nokta sıraları bu hale göredir.
fn read(app: &AppHandle, path: &str) -> Result<gpx_core::parse::Gpx, String> {
    let cfg = app.state::<SettingsStore>().stats();
    gpx_core::read_prepared(Path::new(path), &cfg)
        .map(|(g, _, _)| g)
        .map_err(|e| e.to_string())
}

/// Yeni oluşturulan kaydı kütüphaneye yazıp özetler.
fn store_new(app: &AppHandle, gpx: &gpx_core::parse::Gpx, fallback: &str) -> LoadResult {
    let library = app.state::<Library>();
    let cfg = app.state::<SettingsStore>().stats();
    let name = gpx.name.clone().unwrap_or_else(|| fallback.to_owned());
    match library.write_new(&name, &gpx_core::write::write_gpx(gpx)) {
        Ok(p) => library.load(p.to_string_lossy().into_owned(), &cfg, None),
        Err(e) => LoadResult::Error {
            path: name,
            message: format!("Kaydedilemedi: {e}"),
        },
    }
}

/// Seçilen aralığı yeni bir kayıt olarak kütüphaneye ekler.
#[tauri::command]
async fn trim_file(
    app: AppHandle,
    path: String,
    start: usize,
    end: usize,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let gpx = read(&app, &path)?;
        let out = gpx_core::ops::trim(&gpx, start, end).ok_or("Geçersiz aralık")?;
        Ok(store_new(&app, &out, "Kırpılmış iz"))
    })
    .await?
}

/// Kaydı `at` noktasından ikiye bölüp iki yeni kayıt olarak ekler.
#[tauri::command]
async fn split_file(app: AppHandle, path: String, at: usize) -> Result<Vec<LoadResult>, String> {
    run_blocking(move || {
        let gpx = read(&app, &path)?;
        let (a, b) = gpx_core::ops::split(&gpx, at).ok_or("Bu noktadan bölünemez")?;
        Ok(vec![
            store_new(&app, &a, "1. kısım"),
            store_new(&app, &b, "2. kısım"),
        ])
    })
    .await?
}

/// Kayıtları tek dosyada birleştirip kütüphaneye ekler.
#[tauri::command]
async fn merge_files(
    app: AppHandle,
    paths: Vec<String>,
    name: String,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let parts = paths
            .iter()
            .map(|p| read(&app, p))
            .collect::<Result<Vec<_>, _>>()?;
        let merged = gpx_core::ops::merge(parts, Some(name.clone()));
        Ok(store_new(&app, &merged, &name))
    })
    .await?
}

/// Kütüphanedeki dosyayı seçilen yere seçilen biçimde (gpx, kml, tcx) kaydeder.
#[tauri::command]
async fn export_as(src: String, dest: String, format: String) -> Result<(), String> {
    run_blocking(move || {
        if format == "gpx" {
            return std::fs::copy(&src, &dest)
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
        let (gpx, _) = gpx_core::read_gpx_file(Path::new(&src)).map_err(|e| e.to_string())?;
        let text = match format.as_str() {
            "kml" => gpx_core::formats::write_kml(&gpx),
            "tcx" => gpx_core::formats::write_tcx(&gpx),
            other => return Err(format!("Bilinmeyen biçim: {other}")),
        };
        std::fs::write(&dest, text).map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    run_blocking(move || std::fs::write(&path, contents).map_err(|e| e.to_string())).await?
}

/// Base64 ile gelen ikili veriyi (ör. PNG) dosyaya yazar.
#[tauri::command]
async fn write_base64_file(path: String, data: String) -> Result<(), String> {
    run_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|e| e.to_string())?;
        std::fs::write(&path, bytes).map_err(|e| e.to_string())
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
fn set_settings(app: AppHandle, settings: Settings) -> Result<Vec<String>, String> {
    let store = app.state::<SettingsStore>();
    store.save(settings).map_err(|e| e.to_string())?;
    Ok(start_watcher(&app))
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
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| {
            let p = PathBuf::from(&a);
            let p = match (p.is_absolute(), cwd) {
                (false, Some(cwd)) => cwd.join(p),
                _ => p,
            };
            p.exists().then(|| p.to_string_lossy().into_owned())
        })
        .collect()
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open_files = MenuItemBuilder::with_id("open_files", "Dosya Aç…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open_folder", "Klasör Aç…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let close_all = MenuItemBuilder::with_id("close_all", "Kütüphaneyi Temizle…")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let fit_all = MenuItemBuilder::with_id("fit_all", "Tümünü Göster")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check_updates", "Güncellemeleri Denetle…").build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle_sidebar", "Kenar Çubuğunu Aç/Kapat")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;
    let summary = MenuItemBuilder::with_id("summary", "Özet…")
        .accelerator("CmdOrCtrl+I")
        .build(app)?;
    let heatmap = MenuItemBuilder::with_id("toggle_heatmap", "Isı Haritası")
        .accelerator("CmdOrCtrl+H")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "Ayarlar…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let export_csv = MenuItemBuilder::with_id("export_csv", "Özet Tablosunu Dışa Aktar (CSV)…")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    let export_png = MenuItemBuilder::with_id("export_png", "Harita Görüntüsünü Kaydet (PNG)…")
        .accelerator("CmdOrCtrl+Shift+E")
        .build(app)?;
    let export_gpx = MenuItemBuilder::with_id("export_gpx", "Seçili Kaydı GPX Olarak Kaydet…")
        .accelerator("CmdOrCtrl+S")
        .build(app)?;
    let merge = MenuItemBuilder::with_id("merge", "Seçilenleri Birleştir…").build(app)?;

    let mut file = SubmenuBuilder::new(app, "Dosya")
        .item(&open_files)
        .item(&open_folder)
        .separator()
        .item(&export_gpx)
        .item(&export_csv)
        .item(&export_png)
        .separator()
        .item(&merge)
        .separator()
        .item(&close_all);
    if !cfg!(target_os = "macos") {
        file = file
            .separator()
            .item(&settings)
            .separator()
            .quit_with_text("Çıkış");
    }
    let file = file.build()?;

    // macOS'ta arama kutusunda Cmd+C/V çalışması için Düzen menüsü gereklidir.
    let edit = SubmenuBuilder::new(app, "Düzen")
        .undo_with_text("Geri Al")
        .redo_with_text("Yinele")
        .separator()
        .cut_with_text("Kes")
        .copy_with_text("Kopyala")
        .paste_with_text("Yapıştır")
        .select_all_with_text("Tümünü Seç")
        .build()?;
    let view = SubmenuBuilder::new(app, "Görünüm")
        .item(&fit_all)
        .item(&toggle_sidebar)
        .item(&heatmap)
        .separator()
        .item(&summary)
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "GPXer")
            .about_with_text("GPXer Hakkında", None)
            .item(&check_updates)
            .separator()
            .item(&settings)
            .separator()
            .hide_with_text("GPXer'ı Gizle")
            .hide_others_with_text("Diğerlerini Gizle")
            .show_all_with_text("Tümünü Göster")
            .separator()
            .quit_with_text("GPXer'dan Çık")
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu = menu.item(&file).item(&edit).item(&view);
    if !cfg!(target_os = "macos") {
        let help = SubmenuBuilder::new(app, "Yardım")
            .item(&check_updates)
            .build()?;
        menu = menu.item(&help);
    }
    menu.build()
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
        .manage(PendingPaths::default())
        .setup(|app| {
            let handle = app.handle();
            let root = app.path().app_data_dir()?;
            app.manage(Library::open(&root)?);
            app.manage(SettingsStore::open(&root));
            app.manage(MetaStore::open(&root));
            app.set_menu(build_menu(handle)?)?;
            for e in start_watcher(handle) {
                eprintln!("{e}");
            }
            let initial = paths_from_args(std::env::args().skip(1), None);
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
            take_pending_paths,
            library_files,
            remove_files,
            restore_files,
            flush_cache,
            range_stats,
            trim_file,
            split_file,
            merge_files,
            export_as,
            get_meta,
            set_meta,
            write_text_file,
            write_base64_file,
            get_settings,
            set_settings
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
