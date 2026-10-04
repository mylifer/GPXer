/**
 * Arayüz tercihleri ve görünüm durumu (localStorage). Okunamazsa ya da
 * bozuksa varsayılanlar kullanılır; uygulama bunlar olmadan da çalışır.
 */

import { isCustomLayers, type CustomLayer } from "./customLayers";
import { DEFAULT_FUEL, isFuelPrefs, type FuelPrefs } from "./fuel";
import type { TzMode } from "./format";

export type SortKey = "date-desc" | "date-asc" | "name" | "distance";
export type GroupBy = "none" | "month" | "year";
type ColorMode = "file" | "date";
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
  /** Yalnızca başka bir kayıtla zamanı çakışan kayıtlar. */
  overlap: boolean;
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
  /** Haritada uçuş yayları. */
  flightsLayer: boolean;
  /** Eklenen fotoğrafların (ya da klasörlerin) yolları. */
  photos: string[];
  /** Haritada fotoğraflar. */
  photosLayer: boolean;
  /** Fotoğraf makinesinin saat hatası düzeltmesi (saat). */
  photoOffsetH: number;
  /** Haritada gezilen il ve ülkeler. */
  regionsLayer: boolean;
  /** Haritada yer imleri. */
  bookmarksLayer: boolean;
  /** Kullanıcının eklediği harita katmanları. */
  customLayers: CustomLayer[];
  /** Yıllık hedefler (0: hedef yok). */
  goals: Goals;
  /** Haritada 3B arazi (eğik görünüm, gölgeli kabartma). */
  terrain3d: boolean;
  /** Araç kayıtları için yakıt tüketimi ve fiyatı. */
  fuel: FuelPrefs;
}

export interface Goals {
  /** Yılda gidilecek mesafe (km). */
  km: number;
  /** Yılda kayıt olan (yolda geçen) gün sayısı. */
  days: number;
}

const DEFAULT_FILTERS: Filters = {
  query: "",
  from: "",
  to: "",
  includeUndated: false,
  sort: "date-desc",
  area: null,
  activity: "",
  tag: "",
  route: null,
  overlap: false,
};

/** Listeyi daraltan bir filtre etkin mi (sıralama filtre sayılmaz). */
export const filtersActive = (f: Filters) =>
  !!(f.query.trim() || f.from || f.to || f.activity || f.tag || f.area || f.route || f.overlap);

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
  flightsLayer: false,
  photos: [],
  photosLayer: true,
  photoOffsetH: 0,
  regionsLayer: false,
  fuel: DEFAULT_FUEL,
  terrain3d: false,
  goals: { km: 0, days: 0 },
  customLayers: [],
  bookmarksLayer: true,
};

export const PREFS_KEY = "gpxer.prefs.v1";
const KEY = PREFS_KEY;

export function loadPrefs(): Prefs {
  let saved: unknown = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    saved = {};
  }
  return sanitizePrefs(saved);
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf =
  <T extends string>(...allowed: T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (allowed as string[]).includes(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isMetric = oneOf<Metric>("ele", "speed", "hr", "cad", "power", "temp");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter(isStr) : undefined);
const isBox = (v: unknown): v is [number, number, number, number] =>
  Array.isArray(v) && v.length === 4 && v.every(isNum);

/** Değeri doğrulanırsa onu, değilse varsayılanı seçer. */
function pick<T>(v: unknown, ok: (v: unknown) => v is T, fallback: T): T {
  return ok(v) ? v : fallback;
}

/** Kayıtlı tercihleri doğrular: eski sürümden kalan, elle değiştirilmiş ya da
 * bozuk her alan varsayılanına döner (yanlış türdeki bir alan arayüzü
 * açılışta çökertiyordu). */
export function sanitizePrefs(raw: unknown): Prefs {
  const s: Rec = isRec(raw) ? raw : {};
  const f: Rec = isRec(s.filters) ? s.filters : {};
  const D = DEFAULTS;
  const F = DEFAULT_FILTERS;
  const nullable =
    <T>(ok: (v: unknown) => v is T) =>
    (v: unknown): v is T | null =>
      v === null || ok(v);
  const filters: Filters = {
    query: pick(f.query, isStr, F.query),
    from: pick(f.from, isStr, F.from),
    to: pick(f.to, isStr, F.to),
    includeUndated: pick(f.includeUndated, isBool, F.includeUndated),
    sort: pick(f.sort, oneOf<SortKey>("date-desc", "date-asc", "name", "distance"), F.sort),
    area: pick(f.area, nullable(isBox), F.area),
    activity: pick(f.activity, isStr, F.activity),
    tag: pick(f.tag, isStr, F.tag),
    route: pick(f.route, nullable(isStr), F.route),
    overlap: pick(f.overlap, isBool, F.overlap),
  };
  const isView = (v: unknown): v is Prefs["mapView"] & object =>
    isRec(v) && Array.isArray(v.center) && v.center.length === 2 && v.center.every(isNum) && isNum(v.zoom);
  const colors = isRec(s.colors)
    ? Object.fromEntries(Object.entries(s.colors).filter((e): e is [string, string] => isStr(e[1])))
    : D.colors;
  const series = Array.isArray(s.series) ? s.series.filter(isMetric) : D.series;
  return {
    filters,
    groupBy: pick(s.groupBy, oneOf<GroupBy>("none", "month", "year"), D.groupBy),
    collapsed: strings(s.collapsed) ?? D.collapsed,
    hidden: strings(s.hidden) ?? D.hidden,
    selected: pick(s.selected, nullable(isStr), D.selected),
    mapView: pick(s.mapView, nullable(isView), D.mapView),
    sidebarOpen: pick(s.sidebarOpen, isBool, D.sidebarOpen),
    colorMode: pick(s.colorMode, oneOf<ColorMode>("file", "date"), D.colorMode),
    colors,
    panelHeight: pick(s.panelHeight, isNum, D.panelHeight),
    xAxis: pick(s.xAxis, oneOf<XAxis>("dist", "time"), D.xAxis),
    series,
    trackColorBy: pick(s.trackColorBy, (v): v is TrackColorBy => v === "none" || isMetric(v), D.trackColorBy),
    tzMode: pick(s.tzMode, oneOf<TzMode>("local", "record"), D.tzMode),
    heatmap: pick(s.heatmap, isBool, D.heatmap),
    follow: pick(s.follow, isBool, D.follow),
    playSpeed: pick(s.playSpeed, (v): v is number => isNum(v) && v > 0, D.playSpeed),
    stopsLayer: pick(s.stopsLayer, isBool, D.stopsLayer),
    showGaps: pick(s.showGaps, isBool, D.showGaps),
    multiHintSeen: pick(s.multiHintSeen, isBool, D.multiHintSeen),
    flightsLayer: pick(s.flightsLayer, isBool, D.flightsLayer),
    photos: strings(s.photos) ?? D.photos,
    photosLayer: pick(s.photosLayer, isBool, D.photosLayer),
    photoOffsetH: pick(s.photoOffsetH, isNum, D.photoOffsetH),
    regionsLayer: pick(s.regionsLayer, isBool, D.regionsLayer),
    fuel: pick(s.fuel, isFuelPrefs, D.fuel),
    terrain3d: pick(s.terrain3d, isBool, D.terrain3d),
    customLayers: pick(s.customLayers, isCustomLayers, D.customLayers),
    bookmarksLayer: pick(s.bookmarksLayer, isBool, D.bookmarksLayer),
    goals: pick(
      s.goals,
      (v): v is Goals => !!v && typeof v === "object" && isNum((v as Goals).km) && isNum((v as Goals).days),
      D.goals,
    ),
  };
}

/** Uygulama kapanmadan (ör. güncelleme kurulurken) bekleyen kayıtları
 * hemen yazdırmak için gönderilen olay. */
export const FLUSH_EVENT = "gpxer-flush";

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
  window.addEventListener(FLUSH_EVENT, flushPrefs);
  window.addEventListener("pagehide", flushPrefs);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPrefs();
  });
}
