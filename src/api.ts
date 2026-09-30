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

export interface Waypoint {
  lat: number;
  lon: number;
  ele: number | null;
  name: string | null;
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
  waypoints: Waypoint[];
  /** Kaydın başladığı yerin IANA saat dilimi. */
  timeZone: string | null;
  start: [number, number] | null;
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
}

export type LoadResult =
  | { status: "ok"; file: FileSummary }
  | { status: "error"; path: string; message: string }
  | { status: "duplicate"; path: string; existing: string };

export interface TrashItem {
  original: string;
  trashed: string;
}

export interface StatsConfig {
  movingSpeedMs: number;
  elevationThresholdM: number;
}

export interface Settings {
  stats: StatsConfig;
  watchedFolders: string[];
}

export const expandPaths = (paths: string[]) => invoke<string[]>("expand_paths", { paths });
export const loadFiles = (paths: string[]) => invoke<LoadResult[]>("load_files", { paths });
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
export const exportGpx = (src: string, dest: string) => invoke<void>("export_gpx", { src, dest });
export const writeTextFile = (path: string, contents: string) => invoke<void>("write_text_file", { path, contents });
export const writeBase64File = (path: string, data: string) => invoke<void>("write_base64_file", { path, data });
export const getSettings = () => invoke<Settings>("get_settings");
/** Kaydeder; izlenemeyen klasörler için hata mesajları döner. */
export const setSettings = (settings: Settings) => invoke<string[]>("set_settings", { settings });
