import { invoke } from "@tauri-apps/api/core";

export interface Stats {
  pointCount: number;
  segmentCount: number;
  distanceM: number;
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  movingMs: number | null;
  avgMovingSpeedMs: number | null;
  maxSpeedMs: number | null;
  elevationGainM: number | null;
  elevationLossM: number | null;
  minEleM: number | null;
  maxEleM: number | null;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number] | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCad: number | null;
  avgPower: number | null;
  maxPower: number | null;
  avgTemp: number | null;
}

interface Waypoint {
  lat: number;
  lon: number;
  ele: number | null;
  name: string | null;
}

export interface Gap {
  from: [number, number];
  to: [number, number];
  start: number | null;
  end: number | null;
  distanceM: number;
  /** Uzun boşlukların uçlarındaki yerleşim adları (eski önbellekte yok). */
  fromPlace?: string | null;
  toPlace?: string | null;
}

export interface FileSummary {
  path: string;
  fileName: string;
  name: string | null;
  fileSize: number;
  trackCount: number;
  routeCount: number;
  stats: Stats;
  /** Her çizgi [lon, lat] noktalarından oluşur. */
  lines: [number, number][][];
  /** `lines` ile aynı düzende nokta zamanları (Unix ms); zaman yoksa boş. */
  times: (number | null)[][];
  /** Kayıt boşlukları (uçuş, sinyal kaybı); `lines` bu yerlerde bölünür. */
  gaps: Gap[];
  waypoints: Waypoint[];
  /** Kaydın başladığı yerin IANA saat dilimi. */
  timeZone: string | null;
  start: [number, number] | null;
  end: [number, number] | null;
  startPlace: string | null;
  endPlace: string | null;
  activity: Activity;
  /** Tür kullanıcı tarafından seçildi mi (değilse tahmin). */
  activitySet: boolean;
  stops: Stop[];
  /** Ayıklanan GPS sıçraması sayısı. */
  removedPoints: number;
  /** Uzun duraklamalarda tek noktaya indirildiği için çıkarılan nokta sayısı. */
  collapsedPoints: number;
  /** Saatlik döküm: [saat başı (Unix ms, UTC), mesafe m, hareket ms]; yalnızca
   * verisi olan saatler, boşluklar hariç, sıralı. Eski önbellekte olmayabilir. */
  hours?: [number, number, number][];
  /** Saat saat bulunulan yer, değişince yeni öğe (run-length): [saat başı (Unix ms,
   * UTC), ülke kodu (ISO 3166-1 alfa-2), yer adı]. Eski önbellekte olmayabilir. */
  visits?: [number, string, string][];
}

export type Activity = "walk" | "run" | "bike" | "car" | "unknown";

export interface Stop {
  lat: number;
  lon: number;
  start: number;
  durationMs: number;
}

export interface FileMeta {
  tags: string[];
  note: string;
  activity: Activity | null;
}

export interface Detail {
  dist: number[];
  ele: (number | null)[];
  speed: (number | null)[];
  time: (number | null)[];
  lat: number[];
  lon: number[];
  /** Asıl nokta sıra numarası (kırpma/bölme/aralık istatistiği için). */
  idx: number[];
  hr: (number | null)[];
  cad: (number | null)[];
  power: (number | null)[];
  temp: (number | null)[];
  /** Ardından kayıt boşluğu gelen örnek sıraları (gpx-core is_gap). */
  gapAfter: number[];
}

export type LoadResult =
  | { status: "ok"; file: FileSummary }
  | { status: "error"; path: string; message: string }
  | { status: "duplicate"; path: string; existing: string }
  /** Dosyada hiç nokta yok (ör. başlatılıp hemen durdurulmuş kayıt): atlanır. */
  | { status: "empty"; path: string };

export interface TrashItem {
  original: string;
  trashed: string;
}

interface StatsConfig {
  movingSpeedMs: number;
  elevationThresholdM: number;
  cleanSpikes: boolean;
  perType: boolean;
  /** Uzun duraklamalardaki konum titremesi tek noktaya indirilsin (cleanSpikes açıkken). */
  collapseStays: boolean;
}

/** Kullanıcının adlandırdığı yer ("Ev", "İş"); yarıçap içindeki duraklamalar ve
 * başlangıç/bitiş noktaları bu adla gösterilir. */
export interface NamedPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface PhotoInfo {
  path: string;
  name: string;
  /** Çekim zamanı (Unix ms); bilinmiyorsa null. */
  time: number | null;
  /** true: EXIF'teki saat dilimsiz duvar saati, UTC'ymiş gibi saklandı. */
  timeIsLocal: boolean;
  lat: number | null;
  lon: number | null;
  /** Artık hep null: küçük resimler `photoThumb` ile tembelce yüklenir. */
  thumb: string | null;
}

export interface Settings {
  stats: StatsConfig;
  watchedFolders: string[];
}

export const expandPaths = (paths: string[]) => invoke<string[]>("expand_paths", { paths });
/** `explicit`: kullanıcı dosyaları kendisi açtı (Dosya Aç, Klasör Aç, sürükle-bırak,
 * çift tıklama, "Birlikte aç"); kütüphaneden çıkarılmış kayıtlar da yeniden eklenir.
 * Açılıştaki kütüphane, izlenen klasörler ve yeniden yüklemede verilmez. */
export const loadFiles = (paths: string[], explicit = false) =>
  invoke<LoadResult[]>("load_files", { paths, explicit });
export const flushCache = () => invoke<void>("flush_cache");
export const loadDetail = (path: string) => invoke<Detail>("load_detail", { path });
export const libraryFiles = () => invoke<string[]>("library_files");
export const removeFiles = (paths: string[]) => invoke<TrashItem[]>("remove_files", { paths });
export const restoreFiles = (items: TrashItem[]) => invoke<string[]>("restore_files", { items });
export const takePendingPaths = () => invoke<string[]>("take_pending_paths");
export const rangeStats = (path: string, start: number, end: number) =>
  invoke<Stats>("range_stats", { path, start, end });
export const trimFile = (path: string, start: number, end: number) =>
  invoke<LoadResult>("trim_file", { path, start, end });
export const splitFile = (path: string, at: number) => invoke<LoadResult[]>("split_file", { path, at });
export const mergeFiles = (paths: string[], name: string) => invoke<LoadResult>("merge_files", { paths, name });
export type ExportFormat = "gpx" | "kml" | "tcx" | "fit";
export const exportAs = (src: string, dest: string, format: ExportFormat) =>
  invoke<void>("export_as", { src, dest, format });
export const getMeta = () => invoke<Record<string, FileMeta>>("get_meta");
/** Tür değiştiyse yeniden hesaplanan özet döner. */
export const setMeta = (path: string, value: FileMeta) => invoke<LoadResult | null>("set_meta", { path, value });
export interface RestoreInfo {
  results: LoadResult[];
  metaMerged: number;
  placesAdded: number;
}
/** Kütüphaneyi kaydetme penceresinde seçilen .zip dosyasına yedekler. */
export const backupLibrary = (dest: string) => invoke<{ records: number; bytes: number }>("backup_library", { dest });
/** Yedekten geri yükler: kayıtlar açma yolundan geçer (kopyalar atlanır). */
export const restoreLibrary = (src: string) => invoke<RestoreInfo>("restore_library", { src });
/** Kaydı yerinde değiştiren işlemlerin sonucu: yeni özet, geri almak için
 * saklanan önceki hal ve önceki istatistikler. */
export type RewriteKind = "elevation" | "snap";
export interface RewriteResult {
  result: LoadResult;
  previous: string;
  before: Stats | null;
}
/** Yükseklikleri arazi yüksekliğiyle (çevrimiçi servis) değiştirir. */
export const fixElevation = (path: string) => invoke<RewriteResult>("fix_elevation", { path });
/** Seyrek kaydı yola oturtur (çevrimiçi harita eşleştirme). */
export const snapToRoads = (path: string) => invoke<RewriteResult>("snap_to_roads", { path });
export const undoRewrite = (path: string, previous: string) => invoke<LoadResult>("undo_rewrite", { path, previous });
/** Kayıtlara tek seferde etiket ekler; değişen kayıtların yeni bilgileri döner. */
export const addTag = (paths: string[], tag: string) => invoke<Record<string, FileMeta>>("add_tag", { paths, tag });
interface SaveFilter {
  name: string;
  extensions: string[];
}
/** Sistemin kaydetme penceresini açar. Arka uç yalnızca buradan dönen yollara
 * yazar (write_text_file, write_base64_file, export_as); vazgeçilirse `null`. */
export const pickSavePath = (defaultName: string, filters: SaveFilter[]) =>
  invoke<string | null>("pick_save_path", { defaultName, filters });
export const writeTextFile = (path: string, contents: string) => invoke<void>("write_text_file", { path, contents });
export const writeBase64File = (path: string, data: string) => invoke<void>("write_base64_file", { path, data });
export const getSettings = () => invoke<Settings>("get_settings");

/** Tüm listeyi yazan kayıtlar arka uçta ayrı iş parçacıklarında sırasız
 * çalışabilir; eski liste en son yazılmasın diye her kayıt öncekini bekler. */
export function inOrder<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let last: Promise<unknown> = Promise.resolve();
  return (...args) => {
    const next = last.then(
      () => fn(...args),
      () => fn(...args),
    );
    last = next.catch(() => {});
    return next;
  };
}

/** Kaydeder; izlenemeyen klasörler için hata mesajları döner. */
export const setSettings = inOrder((settings: Settings) => invoke<string[]>("set_settings", { settings }));
export const getPlaces = () => invoke<NamedPlace[] | null>("get_places");
export const setPlaces = inOrder((places: NamedPlace[]) => invoke<void>("set_places", { places }));
/** Dosya ya da klasör yolları; klasörlerdeki fotoğraflar arka uçta bulunur. */
export const readPhotos = (paths: string[]) => invoke<PhotoInfo[] | null>("read_photos", { paths });
/** Fotoğrafın küçük resmi (data: adresi); okunamazsa null. */
export const photoThumb = (path: string) => invoke<string | null>("photo_thumb", { path });
/** Kayıtları tek dosyada dışa aktarır; `dest` pickSavePath'ten gelmeli. */
export const exportMany = (paths: string[], dest: string, format: ExportFormat) =>
  invoke<void>("export_many", { paths, dest, format });
