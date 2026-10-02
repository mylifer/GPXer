/**
 * Arayüz tercihleri ve görünüm durumu (localStorage). Okunamazsa ya da
 * bozuksa varsayılanlar kullanılır; uygulama bunlar olmadan da çalışır.
 */

import type { TzMode } from "./format";

export type SortKey = "date-desc" | "date-asc" | "name" | "distance";
export type GroupBy = "none" | "month" | "year";
export type ColorMode = "file" | "date";
export type Metric = "ele" | "speed" | "hr" | "cad" | "power" | "temp";
export type TrackColorBy = "none" | Metric;
export type XAxis = "dist" | "time";

export interface Filters {
  query: string;
  /** yyyy-aa-gg ya da "" */
  from: string;
  to: string;
  /** Tarih filtresi açıkken zaman bilgisi olmayan kayıtlar da gösterilsin mi. */
  includeUndated: boolean;
  sort: SortKey;
  /** Haritada seçilen alan [minLon, minLat, maxLon, maxLat]: yalnızca oradan geçenler. */
  area: [number, number, number, number] | null;
  /** "" = tümü */
  activity: string;
  tag: string;
  /** Tekrarlanan güzergâhın bir kaydının yolu; yalnızca o kaydı içeren
   * güzergâhın kayıtları gösterilir (üyelik değişse de filtre korunur). */
  route: string | null;
}

export interface Prefs {
  filters: Filters;
  groupBy: GroupBy;
  collapsed: string[];
  /** Haritada gizlenen dosyalar. */
  hidden: string[];
  selected: string | null;
  mapView: { center: [number, number]; zoom: number } | null;
  sidebarOpen: boolean;
  colorMode: ColorMode;
  /** Kullanıcının seçtiği dosya renkleri. */
  colors: Record<string, string>;
  panelHeight: number;
  xAxis: XAxis;
  /** Grafikte gösterilen ölçüler (yükseklik her zaman ilk sırada). */
  series: Metric[];
  trackColorBy: TrackColorBy;
  tzMode: TzMode;
  heatmap: boolean;
  follow: boolean;
  playSpeed: number;
  /** Haritada duraklama yoğunluğu katmanı. */
  stopsLayer: boolean;
  /** Seçili kayıtta kayıt boşluklarını kesik çizgiyle göster. */
  showGaps: boolean;
  /** Çoklu seçim ipucu kapatıldı (ya da çoklu seçim kullanıldı). */
  multiHintSeen: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  query: "",
  from: "",
  to: "",
  includeUndated: false,
  sort: "date-desc",
  area: null,
  activity: "",
  tag: "",
  route: null,
};

/** Listeyi daraltan bir filtre etkin mi (sıralama filtre sayılmaz). */
export const filtersActive = (f: Filters) =>
  !!(f.query.trim() || f.from || f.to || f.activity || f.tag || f.area || f.route);

/** Filtreleri kaldırır; sıralama korunur. */
export const resetFilters = (f: Filters): Filters => ({ ...DEFAULT_FILTERS, sort: f.sort });

const DEFAULTS: Prefs = {
  filters: DEFAULT_FILTERS,
  groupBy: "month",
  collapsed: [],
  hidden: [],
  selected: null,
  mapView: null,
  sidebarOpen: true,
  colorMode: "file",
  colors: {},
  panelHeight: 340,
  xAxis: "dist",
  series: ["ele", "speed"],
  trackColorBy: "none",
  tzMode: "local",
  heatmap: false,
  follow: true,
  playSpeed: 60,
  stopsLayer: false,
  showGaps: true,
  multiHintSeen: false,
};

const KEY = "gpxer.prefs.v1";

export function loadPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {};
  } catch {
    saved = {};
  }
  return { ...DEFAULTS, ...saved, filters: { ...DEFAULT_FILTERS, ...(saved.filters ?? {}) } };
}

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Prefs | null = null;

function write(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* önemli değil */
  }
}

/** Sık değişen durum (harita konumu gibi) için yazma kısa süre ertelenir. */
export function savePrefs(p: Prefs) {
  pending = p;
  clearTimeout(timer);
  timer = setTimeout(flushPrefs, 300);
}

/** Bekleyen ertelenmiş yazmayı hemen yapar (kapanışta kaybolmasın). */
export function flushPrefs() {
  clearTimeout(timer);
  timer = undefined;
  if (!pending) return;
  const p = pending;
  pending = null;
  write(p);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", flushPrefs);
  window.addEventListener("pagehide", flushPrefs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPrefs();
  });
}
