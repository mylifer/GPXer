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
  /** Gizlilik bölgesi: dışa aktarma ve paylaşımlarda çevresi (en az 300 m) kırpılır. */
  private?: boolean;
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
  /** Cihazlar arası eşitleme klasörü (yoksa eşitleme kapalı). */
  syncFolder?: string | null;
  /** Otomatik yedek klasörü (yoksa otomatik yedek kapalı). */
  backupFolder?: string | null;
  /** Otomatik yedek aralığı (gün; 0 → 7). */
  backupDays?: number;
}

/** Arşiv sağlık denetiminin sonucu. */
export interface ArchiveReport {
  total: number;
  ok: number;
  missing: string[];
  corrupted: string[];
  unreadable: string[];
  checkedAt: number;
  lastBackup: number | null;
}
export const archiveCheck = () => invoke<ArchiveReport>("archive_check");
export const archiveInfo = () => invoke<{ lastBackup: number | null; lastAutoBackup: number | null; lastCheck: number | null }>("archive_info");
/** Uygulamadan bağımsız açık arşiv (klasör seçilir); vazgeçilirse null. */
export const exportOpenArchive = () => invoke<{ folder: string; records: number } | null>("export_open_archive");
/** Otomatik yedeği şimdi alır; yazılan dosyanın yolu. */
export const backupNow = () => invoke<string>("backup_now");

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
export const backupLibrary = (dest: string, password: string | null = null) =>
  invoke<{ records: number; bytes: number }>("backup_library", { dest, password });
/** Yedekten geri yükler: kayıtlar açma yolundan geçer (kopyalar atlanır). */
export const restoreLibrary = (src: string, password: string | null = null) =>
  invoke<RestoreInfo>("restore_library", { src, password });
/** Şifreli yedek parolasız açılmaya çalışıldı. */
export const NEED_PASSWORD = "PAROLA_GEREKLI";
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
/** Kayıtta noktaları siler / bir noktayı taşır (yerinde, geri alınabilir). */
export const deletePoints = (path: string, start: number, end: number) =>
  invoke<RewriteResult>("delete_points", { path, start, end });
export const movePoint = (path: string, index: number, lat: number, lon: number) =>
  invoke<RewriteResult>("move_point", { path, index, lat, lon });
export const undoRewrite = (path: string, previous: string) => invoke<LoadResult>("undo_rewrite", { path, previous });
export interface Bookmark {
  id: string;
  name: string;
  note: string;
  lat: number;
  lon: number;
  /** Gidilmek istenen yer. */
  wish: boolean;
  created: number;
}
export const getBookmarks = () => invoke<Bookmark[]>("get_bookmarks");
export const setBookmarks = (items: Bookmark[]) => invoke<void>("set_bookmarks", { items });
export interface PlannedRoute {
  /** [enlem, boylam] */
  coords: [number, number][];
  distanceM: number;
  durationS: number;
}
/** Noktalardan geçen rota (OSRM, routing.openstreetmap.de). */
export const planRoute = (profile: "car" | "bike" | "foot", points: [number, number][]) =>
  invoke<PlannedRoute>("plan_route", { profile, points });
/** Çevrimdışı harita: karoları önbelleğe indirir; önbellek boyutu ve temizleme. */
export const prefetchTiles = (urls: string[]) => invoke<number>("prefetch_tiles", { urls });
export const tileCacheInfo = () => invoke<{ bytes: number; count: number }>("tile_cache_info");
export const clearTileCache = () => invoke<void>("clear_tile_cache");
/** Arayüzde oluşturulan GPX metnini yeni kayıt olarak ekler. */
export const addGpxRecord = (name: string, gpx: string) => invoke<LoadResult>("add_gpx_record", { name, gpx });
/** Konumun IANA saat dilimi. */
export const timeZoneAt = (lon: number, lat: number) => invoke<string | null>("time_zone_at", { lon, lat });
/** Hesap dışa aktarma arşivini (Strava, Garmin Connect, Google Takeout zip) içe aktarır. */
export const importArchive = (src: string) =>
  invoke<{ results: LoadResult[]; source: string; typed: number; skipped: number }>("import_archive", { src });
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
/** Konumu tarayıcıda sokak görünümüyle açar. */
export const openStreetView = (service: "google" | "yandex", lat: number, lon: number) =>
  invoke<void>("open_street_view", { service, lat, lon });
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
/** Haritada yer arama sonucu. */
export interface PlaceHit {
  name: string;
  detail: string;
  lat: number;
  lon: number;
  /** [batı, güney, doğu, kuzey] */
  bbox: [number, number, number, number] | null;
  kind: string;
}
/** Çevrimdışı yerleşim araması (`prefer`: öne alınacak ülke kodları). */
export const searchPlacesOffline = (query: string, prefer: string[]) => invoke<PlaceHit[]>("search_places_offline", { query, prefer });
/** Çevrimiçi yer/adres araması (OpenStreetMap, Photon); haritanın ortasına yakın sonuçlar önce. */
export const searchPlacesOnline = (query: string, lat: number | null, lon: number | null) =>
  invoke<PlaceHit[]>("search_places_online", { query, lat, lon });
/** Eşitleme sonucu. */
export interface SyncReport {
  pushed: number;
  pulled: number;
  removedLocal: number;
  removedRemote: number;
  /** Aynı adla iki cihazda farklı içerik: dokunulmadı. */
  conflicts: string[];
  /** Bulut istemcisinin henüz indirmediği dosyalar. */
  waiting: number;
  metaChanged: boolean;
  placesChanged: boolean;
  bookmarksChanged: boolean;
  journalChanged?: boolean;
  added: LoadResult[];
  updated: LoadResult[];
  removed: string[];
  at: number;
}
/** Seçili klasörle şimdi eşitler. */
export const syncNow = () => invoke<SyncReport>("sync_now");
/** Eşitleme klasörü ve son eşitleme zamanı. */
export const syncInfo = () => invoke<{ folder: string | null; last: number | null }>("sync_info");
/** Çevrimdışı sokak, mahalle ve mekân araması (gezilen/indirilen harita bölgelerinden). */
export const searchStreetsOffline = (query: string, lat: number | null, lon: number | null) =>
  invoke<PlaceHit[]>("search_streets_offline", { query, lat, lon });
/** Çevrimdışı arama dizinindeki ad ve karo sayısı. */
export const streetsInfo = () => invoke<[number, number]>("streets_info");
/** z14 karolarını indirip sokak dizinine ekler: [işlenen karo, dizindeki ad]. */
export const indexStreetTiles = (tiles: [number, number][]) => invoke<[number, number]>("index_street_tiles", { tiles });
/** Güzergâh dökümünde bir yol bölümü (`from`/`to`: ayrıntı örneği sırası). */
export interface RoadSeg {
  name: string | null;
  small: string | null;
  big: string | null;
  from: number;
  to: number;
  distM: number;
}
/** Kaydın geçtiği yollar sırayla (önbellekte yoksa hesaplanır; karo indirebilir). */
export const recordRoads = (path: string) => invoke<RoadSeg[]>("record_roads", { path });
/** Kayıtların dökümlerini hazırlar; hazır olan sayısı. */
export const prepareRoads = (paths: string[]) => invoke<number>("prepare_roads", { paths });
export interface RoadStats {
  ready: number;
  /** (ad, ilçe, toplam m, kayıt sayısı) */
  roads: [string, string | null, number, number][];
  /** (ilçe, [(mahalle, kayıt sayısı)]) */
  hoods: [string, [string, number][]][];
}
export const roadStats = (paths: string[]) => invoke<RoadStats>("road_stats", { paths });
/** Noktadaki sokak ve mahalle/ilçe (vektör karolarından). */
export const streetAt = (lon: number, lat: number) => invoke<{ street: string | null; area: string | null }>("street_at", { lon, lat });
/** Son çevrimiçi aramanın adımları: [sorgu, satırlar]. */
export const searchTrace = () => invoke<[string, string[]]>("search_trace");
