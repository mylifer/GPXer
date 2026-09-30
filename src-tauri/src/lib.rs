use gpx_core::{Detail, FileSummary};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;
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
    Ok {
        file: Box<FileSummary>,
    },
    Error {
        path: String,
        message: String,
    },
    /// İçeriği kütüphanedeki `existing` dosyasıyla aynı.
    Duplicate {
        path: String,
        existing: String,
    },
}

/// Açılan dosyaların kopyalarının saklandığı klasör. Uygulama her
/// açılışta bu klasördeki dosyaları yükler.
struct Library {
    dir: PathBuf,
    /// İçerik parmak izi → kütüphanedeki dosya yolu.
    known: Mutex<HashMap<u64, String>>,
}

impl Library {
    fn contains(&self, path: &Path) -> bool {
        path.parent() == Some(self.dir.as_path())
    }

    /// Kütüphanede aynı adla dosya varsa "ad (2).gpx" gibi boş bir ad bulup
    /// dosyayı oraya kopyalar.
    fn copy_in(&self, src: &Path) -> std::io::Result<PathBuf> {
        let stem = src
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "iz".into());
        let mut target = self.dir.join(format!("{stem}.gpx"));
        let mut n = 2;
        while target.exists() {
            target = self.dir.join(format!("{stem} ({n}).gpx"));
            n += 1;
        }
        std::fs::copy(src, &target)?;
        Ok(target)
    }

    /// Okunan dosyayı kütüphaneye ekler: kopyasıysa atlar, dışarıdan
    /// geliyorsa kütüphane klasörüne kopyalar.
    fn add(&self, path: String, mut file: FileSummary, fingerprint: u64) -> LoadResult {
        let mut known = self.known.lock().unwrap();
        if let Some(existing) = known.get(&fingerprint) {
            if *existing == path {
                return LoadResult::Ok {
                    file: Box::new(file),
                };
            }
            return LoadResult::Duplicate {
                path,
                existing: existing.clone(),
            };
        }
        let stored = if self.contains(Path::new(&path)) {
            path
        } else {
            match self.copy_in(Path::new(&path)) {
                Ok(p) => p.to_string_lossy().into_owned(),
                Err(e) => {
                    return LoadResult::Error {
                        path,
                        message: format!("Kütüphaneye kopyalanamadı: {e}"),
                    }
                }
            }
        };
        known.insert(fingerprint, stored.clone());
        file.path = stored;
        LoadResult::Ok {
            file: Box::new(file),
        }
    }
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

/// Dosyaları paralel olarak okuyup özetler ve kütüphaneye ekler.
#[tauri::command]
async fn load_files(app: AppHandle, paths: Vec<String>) -> Result<Vec<LoadResult>, String> {
    run_blocking(move || {
        let parsed: Vec<_> = paths
            .into_par_iter()
            .map(|p| {
                let res = gpx_core::read_gpx_file(Path::new(&p)).and_then(|(gpx, size)| {
                    let fp = gpx_core::fingerprint(&gpx);
                    gpx_core::summarize(&gpx, &p, size).map(|s| (s, fp))
                });
                (p, res)
            })
            .collect();
        // Kopya denetimi sırayla yapılır ki aynı partide gelen iki kopya da
        // yakalansın.
        let library = app.state::<Library>();
        parsed
            .into_iter()
            .map(|(p, res)| match res {
                Ok((file, fp)) => library.add(p, file, fp),
                Err(e) => LoadResult::Error {
                    path: p,
                    message: e.to_string(),
                },
            })
            .collect()
    })
    .await
}

/// Kütüphanedeki dosyaların yolları.
#[tauri::command]
fn library_files(library: tauri::State<'_, Library>) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(&library.dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_gpx(p))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}

/// Dosyayı kütüphaneden siler.
#[tauri::command]
fn remove_files(library: tauri::State<'_, Library>, paths: Vec<String>) -> Result<(), String> {
    let mut known = library.known.lock().unwrap();
    for p in paths {
        known.retain(|_, v| *v != p);
        let path = Path::new(&p);
        if library.contains(path) {
            match std::fs::remove_file(path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        }
    }
    Ok(())
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
            .item(&check_updates)
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
            let dir = app.path().app_data_dir()?.join("library");
            std::fs::create_dir_all(&dir)?;
            app.manage(Library {
                dir,
                known: Mutex::default(),
            });
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
            take_pending_paths,
            library_files,
            remove_files
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

#[cfg(test)]
mod tests {
    use super::*;

    fn load(lib: &Library, path: &Path) -> LoadResult {
        let (gpx, size) = gpx_core::read_gpx_file(path).unwrap();
        let p = path.to_string_lossy().into_owned();
        let summary = gpx_core::summarize(&gpx, &p, size).unwrap();
        lib.add(p, summary, gpx_core::fingerprint(&gpx))
    }

    #[test]
    fn library_copies_and_detects_duplicates() {
        let root = std::env::temp_dir().join(format!("gpxer-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (src, dir) = (root.join("src"), root.join("library"));
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&dir).unwrap();
        let track = |lat: &str| {
            format!(
                r#"<gpx><trk><trkseg><trkpt lat="{lat}" lon="29"/><trkpt lat="41.01" lon="29"/></trkseg></trk></gpx>"#
            )
        };
        std::fs::write(src.join("a.gpx"), track("41.0")).unwrap();
        std::fs::write(src.join("a-kopya.gpx"), track("41.000")).unwrap();
        std::fs::create_dir_all(src.join("alt")).unwrap();
        std::fs::write(src.join("alt").join("a.gpx"), track("41.002")).unwrap();

        let lib = Library {
            dir: dir.clone(),
            known: Mutex::default(),
        };
        let LoadResult::Ok { file } = load(&lib, &src.join("a.gpx")) else {
            panic!()
        };
        assert_eq!(Path::new(&file.path), dir.join("a.gpx"));
        assert!(dir.join("a.gpx").exists());

        let LoadResult::Duplicate { existing, .. } = load(&lib, &src.join("a-kopya.gpx")) else {
            panic!()
        };
        assert_eq!(Path::new(&existing), dir.join("a.gpx"));

        // Aynı adlı ama farklı içerikli dosya yeni adla kopyalanır.
        let LoadResult::Ok { file } = load(&lib, &src.join("alt").join("a.gpx")) else {
            panic!()
        };
        assert_eq!(Path::new(&file.path), dir.join("a (2).gpx"));

        // Yeniden başlatma: kütüphane dosyaları kopyalanmadan yüklenir.
        let lib2 = Library {
            dir: dir.clone(),
            known: Mutex::default(),
        };
        assert!(matches!(
            load(&lib2, &dir.join("a.gpx")),
            LoadResult::Ok { .. }
        ));
        assert!(matches!(
            load(&lib2, &src.join("a.gpx")),
            LoadResult::Duplicate { .. }
        ));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
