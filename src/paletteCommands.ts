/** Komut paletinin (Ctrl/⌘+K) komutları: işlemler, katmanlar, altlıklar,
 * seçili kayıt, yerler ve kayıtlar. */
import type { Bookmark, FileSummary, NamedPlace } from "./api";
import type { Command } from "./components/CommandPalette";
import { fmtDate, tzOf } from "./format";
import type { SetDialog } from "./hooks/dialog";
import { BASE_LAYERS, type BaseLayer } from "./map/style";
import type { Prefs } from "./prefs";

export interface PaletteContext {
  pickFiles(): void;
  pickFolder(): void;
  setDialog: SetDialog;
  openGoTo(): void;
  /** Kopya kayıt grubu sayısı. */
  duplicates: number;
  openPlan(): void;
  downloadArea(): void;
  fitAll(): void;
  exportPng(): void;
  exportCsv(): void;
  backup(): void;
  openArchive(): void;
  restore(): void;
  /** Eşitleme klasörü seçiliyse elle eşitleme. */
  sync: (() => void) | null;
  prefs: Prefs;
  up(patch: Partial<Prefs>): void;
  setBaseLayer(id: BaseLayer): void;
  selected: FileSummary | null;
  zoomTo(path: string): void;
  exportSelectedGpx(): void;
  makeStory(): void;
  rewrite(path: string, kind: "elevation" | "snap"): void;
  editPoints(): void;
  places: NamedPlace[];
  bookmarks: Bookmark[];
  centerOn(lonLat: [number, number], zoom: number): void;
  records: FileSummary[];
  selectAndZoom(path: string): void;
  /** Fotoğraf ekle (`true`: klasör seç; klasör izlenir). */
  pickPhotos(folder: boolean): void;
}

export function paletteCommands(x: PaletteContext): Command[] {
  const c: Command[] = [];
  const add = (group: string, id: string, label: string, run: () => void, hint?: string, keywords?: string) =>
    c.push({ group, id, label, run, hint, keywords });
  const MOD = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";
  add("İşlem", "open", "Dosya aç…", x.pickFiles, `${MOD}+O`, "gpx fit tcx kml zip strava garmin takeout içe aktar");
  add("İşlem", "folder", "Klasör aç…", x.pickFolder, `${MOD}+Shift+O`);
  add("İşlem", "photo-folder", "Fotoğraf klasörü ekle…", () => x.pickPhotos(true), undefined, "resim foto telefon izle");
  add("İşlem", "photos", "Fotoğraf ekle…", () => x.pickPhotos(false), undefined, "resim foto jpg heic");
  add("İşlem", "summary", "Özet", () => x.setDialog("summary"), `${MOD}+I`, "istatistik yıl kartı hedef ülke il");
  add("İşlem", "settings", "Ayarlar", () => x.setDialog("settings"), `${MOD}+,`, "yakıt hedef katman gizlilik yedek");
  add("İşlem", "day", "Gün akışı", () => x.setDialog("day"), undefined, "zaman çizelgesi timeline");
  add("İşlem", "goto", "Tarihe git (neredeydim?)", x.openGoTo, "G");
  add("İşlem", "mileage", "Kilometre defteri…", () => x.setDialog("mileage"), undefined, "iş yolculuk km masraf yakıt vergi");
  add("İşlem", "search", "Gelişmiş arama…", () => x.setDialog("search"), undefined, "filtre mesafe km hafta sonu kişi etiket");
  for (const s of x.prefs.savedSearches)
    add("Kayıtlı arama", `saved:${s.name}`, `Kayıtlı arama: ${s.name}`, () => x.up({ filters: s.filters }), undefined, "filtre");
  if (x.duplicates) add("İşlem", "dups", `Kopya kayıtlar (${x.duplicates})`, () => x.setDialog("duplicates"));
  add("İşlem", "search", "Haritada ara", () => window.dispatchEvent(new Event("gpxer:open-search")), `${MOD}+F`, "yer adres şehir bul");
  add("İşlem", "plan", "Rota planla", () => x.openPlan(), undefined, "yol tarifi güzergah");
  add("İşlem", "bookmarks", "Yer imleri listesi", () => x.setDialog("bookmarks"), undefined, "gitmek istediklerim");
  add("İşlem", "offline", "Görünen alanı çevrimdışı için indir", x.downloadArea, undefined, "offline karo");
  add("İşlem", "streets", "Sokakları çevrimdışı aramaya ekle", () => x.setDialog("streets"), undefined, "il sokak indir arama offline");
  add("İşlem", "fit", "Tümüne yakınlaştır", x.fitAll, `${MOD}+0`);
  add("İşlem", "png", "Harita görüntüsünü kaydet (PNG)", x.exportPng, `${MOD}+Shift+E`);
  add("İşlem", "csv", "Özet tablosunu dışa aktar (CSV)", x.exportCsv, `${MOD}+E`);
  add("İşlem", "backup", "Yedek al…", x.backup, undefined, "zip parola");
  if (x.sync) add("İşlem", "sync", "Şimdi eşitle", x.sync, undefined, "drive icloud dropbox onedrive bulut");
  add("İşlem", "restore", "Yedekten geri yükle…", x.restore);
  add("İşlem", "open-archive", "Açık arşiv olarak dışa aktar…", x.openArchive, undefined, "csv html klasör arşiv bağımsız");
  add("İşlem", "sidebar", "Kenar çubuğunu aç/kapat", () => x.up({ sidebarOpen: !x.prefs.sidebarOpen }), `${MOD}+B`);
  add("İşlem", "help", "Yardım ve kısayollar", () => x.setDialog("help"), "?");
  const toggle = (id: string, label: string, on: boolean, patch: Partial<Prefs>) => add("Katman", id, `${label}: ${on ? "kapat" : "aç"}`, () => x.up(patch));
  toggle("heat", "Isı haritası", x.prefs.heatmap, { heatmap: !x.prefs.heatmap });
  toggle("regions", "Gezilen il ve ülkeler", x.prefs.regionsLayer, { regionsLayer: !x.prefs.regionsLayer });
  toggle("terrain", "3B arazi", x.prefs.terrain3d, { terrain3d: !x.prefs.terrain3d });
  toggle("explorer", "Keşif kareleri", x.prefs.explorerLayer, { explorerLayer: !x.prefs.explorerLayer });
  toggle("bm", "Yer imleri", x.prefs.bookmarksLayer, { bookmarksLayer: !x.prefs.bookmarksLayer });
  toggle("flights", "Uçuşlar", x.prefs.flightsLayer, { flightsLayer: !x.prefs.flightsLayer });
  toggle("stops", "Duraklamalar", x.prefs.stopsLayer, { stopsLayer: !x.prefs.stopsLayer });
  for (const l of BASE_LAYERS) add("Altlık", `base-${l.id}`, `Altlık: ${l.label}`, () => x.setBaseLayer(l.id));
  if (x.selected) {
    const s = x.selected;
    const nm = s.name || s.fileName;
    add("Seçili", "sel-zoom", `Yakınlaştır: ${nm}`, () => x.zoomTo(s.path));
    add("Seçili", "sel-save", "Farklı kaydet…", x.exportSelectedGpx, `${MOD}+S`);
    add("Seçili", "sel-video", "Yolculuk videosu…", () => x.setDialog("video"));
    add("Seçili", "sel-story", "Gezi hikâyesi (HTML)…", x.makeStory);
    add("Seçili", "sel-ele", "Yüksekliği düzelt", () => x.rewrite(s.path, "elevation"), undefined, "dem arazi");
    add("Seçili", "sel-snap", "Yola oturt", () => x.rewrite(s.path, "snap"), undefined, "harita eşleştirme");
    add("Seçili", "sel-edit", "Noktaları düzenle", x.editPoints);
  }
  for (const p of x.places) add("Yer", `place-${p.id}`, p.name, () => x.centerOn([p.lon, p.lat], 14), "adlandırılmış yer");
  for (const b of x.bookmarks) add("Yer", `bm-${b.id}`, `${b.wish ? "⭐" : "📌"} ${b.name}`, () => x.centerOn([b.lon, b.lat], 13), "yer imi", b.note);
  for (const s of x.records) {
    add(
      "Kayıt",
      `rec-${s.path}`,
      s.name || s.fileName,
      () => x.selectAndZoom(s.path),
      s.stats.startTime != null ? fmtDate(s.stats.startTime, tzOf(s)) : undefined,
      `${s.fileName} ${s.startPlace ?? ""} ${s.endPlace ?? ""}`,
    );
  }
  return c;
}
