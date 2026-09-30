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
}

export interface Detail {
  dist: number[];
  ele: (number | null)[];
  speed: (number | null)[];
  time: (number | null)[];
  lat: number[];
  lon: number[];
}

export type LoadResult =
  | { status: "ok"; file: FileSummary }
  | { status: "error"; path: string; message: string }
  | { status: "duplicate"; path: string; existing: string };

export const expandPaths = (paths: string[]) => invoke<string[]>("expand_paths", { paths });
export const loadFiles = (paths: string[]) => invoke<LoadResult[]>("load_files", { paths });
export const loadDetail = (path: string) => invoke<Detail>("load_detail", { path });
export const libraryFiles = () => invoke<string[]>("library_files");
export const removeFiles = (paths: string[]) => invoke<void>("remove_files", { paths });
export const takePendingPaths = () => invoke<string[]>("take_pending_paths");
