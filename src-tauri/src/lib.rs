use gpx_core::{Detail, FileSummary};
use rayon::prelude::*;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

/// İşletim sisteminden gelen (çift tıklama, "Birlikte aç", ikinci örnek)
/// ama arayüzün henüz almadığı dosya yolları.
#[derive(Default)]
struct PendingPaths(Mutex<Vec<String>>);

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum LoadResult {
    Ok { file: Box<FileSummary> },
    Error { path: String, message: String },
}

fn is_gpx(path: &Path) -> bool {
    path.extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("gpx"))
}

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
                    .filter(|e| e.file_type().is_file() && is_gpx(e.path()))
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

/// Dosyaları paralel olarak okuyup özetler.
#[tauri::command]
async fn load_files(paths: Vec<String>) -> Result<Vec<LoadResult>, String> {
    run_blocking(move || {
        paths
            .into_par_iter()
            .map(|p| match gpx_core::load_summary(Path::new(&p)) {
                Ok(file) => LoadResult::Ok {
                    file: Box::new(file),
                },
                Err(e) => LoadResult::Error {
                    path: p,
                    message: e.to_string(),
                },
            })
            .collect()
    })
    .await
}

#[tauri::command]
async fn load_detail(path: String) -> Result<Detail, String> {
    run_blocking(move || gpx_core::load_detail(Path::new(&path)).map_err(|e| e.to_string())).await?
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
    let close_all = MenuItemBuilder::with_id("close_all", "Tümünü Kapat")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let fit_all = MenuItemBuilder::with_id("fit_all", "Tümünü Göster")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle_sidebar", "Kenar Çubuğunu Aç/Kapat")
        .accelerator("CmdOrCtrl+B")
        .build(app)?;

    let mut file = SubmenuBuilder::new(app, "Dosya")
        .item(&open_files)
        .item(&open_folder)
        .separator()
        .item(&close_all);
    if !cfg!(target_os = "macos") {
        file = file.separator().quit_with_text("Çıkış");
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
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "GPXer")
            .about_with_text("GPXer Hakkında", None)
            .separator()
            .hide_with_text("GPXer'ı Gizle")
            .hide_others_with_text("Diğerlerini Gizle")
            .show_all_with_text("Tümünü Göster")
            .separator()
            .quit_with_text("GPXer'dan Çık")
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file).item(&edit).item(&view).build()
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
        .manage(PendingPaths::default())
        .setup(|app| {
            let handle = app.handle();
            app.set_menu(build_menu(handle)?)?;
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
            take_pending_paths
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
