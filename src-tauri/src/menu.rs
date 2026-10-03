//! Uygulama menüsü.

use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::AppHandle;

pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let open_files = MenuItemBuilder::with_id("open_files", "Dosya Aç…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let open_folder = MenuItemBuilder::with_id("open_folder", "Klasör Aç…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let close_all = MenuItemBuilder::with_id("close_all", "Kütüphaneyi Boşalt…")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(app)?;
    let fit_all = MenuItemBuilder::with_id("fit_all", "Tüm Kayıtlara Yakınlaştır")
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
        .accelerator("CmdOrCtrl+Shift+H")
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
    let export_gpx = MenuItemBuilder::with_id("export_gpx", "Seçili Kaydı Farklı Kaydet…")
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
