//! Uygulama menüsü.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::AppHandle;

pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    build_menu_in(app, false)
}

/// Menüyü arayüz diline göre yeniden kurar.
#[tauri::command]
pub(crate) fn set_menu_language(app: AppHandle, lang: String) -> Result<(), String> {
    let menu = build_menu_in(&app, lang == "en").map_err(|e| e.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|e| e.to_string())
}

fn build_menu_in(app: &AppHandle, en: bool) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let l = |tr: &'static str, eng: &'static str| if en { eng } else { tr };
    let open_files = MenuItemBuilder::with_id("open_files", l("Dosya Aç…", "Open Files…"))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open_folder", l("Klasör Aç…", "Open Folder…"))
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let close_all =
        MenuItemBuilder::with_id("close_all", l("Kütüphaneyi Boşalt…", "Empty Library…"))
            .accelerator("CmdOrCtrl+Shift+W")
            .build(app)?;
    let fit_all = MenuItemBuilder::with_id(
        "fit_all",
        l("Tüm Kayıtlara Yakınlaştır", "Zoom to All Recordings"),
    )
    .accelerator("CmdOrCtrl+0")
    .build(app)?;
    let check_updates = MenuItemBuilder::with_id(
        "check_updates",
        l("Güncellemeleri Denetle…", "Check for Updates…"),
    )
    .build(app)?;
    let toggle_sidebar = MenuItemBuilder::with_id(
        "toggle_sidebar",
        l("Kenar Çubuğunu Aç/Kapat", "Toggle Sidebar"),
    )
    .accelerator("CmdOrCtrl+B")
    .build(app)?;
    let summary = MenuItemBuilder::with_id("summary", l("Özet…", "Summary…"))
        .accelerator("CmdOrCtrl+I")
        .build(app)?;
    let heatmap = MenuItemBuilder::with_id("toggle_heatmap", l("Isı Haritası", "Heatmap"))
        .accelerator("CmdOrCtrl+Shift+H")
        .build(app)?;
    let settings = MenuItemBuilder::with_id("settings", l("Ayarlar…", "Settings…"))
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    let export_csv = MenuItemBuilder::with_id(
        "export_csv",
        l(
            "Özet Tablosunu Dışa Aktar (CSV)…",
            "Export Summary Table (CSV)…",
        ),
    )
    .accelerator("CmdOrCtrl+E")
    .build(app)?;
    let export_png = MenuItemBuilder::with_id(
        "export_png",
        l("Harita Görüntüsünü Kaydet (PNG)…", "Save Map Image (PNG)…"),
    )
    .accelerator("CmdOrCtrl+Shift+E")
    .build(app)?;
    let export_gpx = MenuItemBuilder::with_id(
        "export_gpx",
        l("Seçili Kaydı Farklı Kaydet…", "Save Selected Recording As…"),
    )
    .accelerator("CmdOrCtrl+S")
    .build(app)?;
    let merge = MenuItemBuilder::with_id("merge", l("Seçilenleri Birleştir…", "Merge Selected…"))
        .build(app)?;
    let palette = MenuItemBuilder::with_id("palette", l("Komut Paleti…", "Command Palette…"))
        .accelerator("CmdOrCtrl+K")
        .build(app)?;

    let mut file = SubmenuBuilder::new(app, l("Dosya", "File"))
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
            .quit_with_text(l("Çıkış", "Quit"));
    }
    let file = file.build()?;

    // macOS'ta arama kutusunda Cmd+C/V çalışması için Düzen menüsü gereklidir.
    let edit = SubmenuBuilder::new(app, l("Düzen", "Edit"))
        .undo_with_text(l("Geri Al", "Undo"))
        .redo_with_text(l("Yinele", "Redo"))
        .separator()
        .cut_with_text(l("Kes", "Cut"))
        .copy_with_text(l("Kopyala", "Copy"))
        .paste_with_text(l("Yapıştır", "Paste"))
        .select_all_with_text(l("Tümünü Seç", "Select All"))
        .build()?;
    let view = SubmenuBuilder::new(app, l("Görünüm", "View"))
        .item(&fit_all)
        .item(&toggle_sidebar)
        .item(&heatmap)
        .separator()
        .item(&summary)
        .item(&palette)
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let app_menu = SubmenuBuilder::new(app, "GPXer")
            .about_with_text(l("GPXer Hakkında", "About GPXer"), None)
            .item(&check_updates)
            .separator()
            .item(&settings)
            .separator()
            .hide_with_text(l("GPXer'ı Gizle", "Hide GPXer"))
            .hide_others_with_text(l("Diğerlerini Gizle", "Hide Others"))
            .show_all_with_text(l("Tümünü Göster", "Show All"))
            .separator()
            .quit_with_text(l("GPXer'dan Çık", "Quit GPXer"))
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu = menu.item(&file).item(&edit).item(&view);
    if !cfg!(target_os = "macos") {
        let help = SubmenuBuilder::new(app, l("Yardım", "Help"))
            .item(&check_updates)
            .build()?;
        menu = menu.item(&help);
    }
    menu.build()
}
