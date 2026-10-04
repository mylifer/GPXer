import { t } from "./i18n";
import type { FileSummary } from "./api";
import { namedPlaceAt } from "./places";

export interface FileEntry {
  summary: FileSummary;
  /** Haritada ve listede kullanılan renk. */
  color: string;
  visible: boolean;
}

/** Birbirinden kolay ayırt edilen, harita üzerinde okunaklı renkler. */
export const PALETTE = [
  "#e6194b",
  "#3c78d8",
  "#f58231",
  "#2e9e44",
  "#911eb4",
  "#00a3a3",
  "#d4379b",
  "#8c6d1f",
  "#1a237e",
  "#c0392b",
  "#6a9a00",
  "#ff6f00",
];

/** Rengi dosyanın kendisine bağlar: aynı dosya her açılışta aynı renkte olur. */
export function defaultColor(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

/** Tek tonlu sıralı (sequential) mavi skala; açık → koyu. */
export const SEQ_LIGHT = ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281", "#0d366b"];
/** Koyu altlıkta ters: koyu → açık, yüksek değer öne çıkar. */
export const SEQ_DARK = ["#184f95", "#1c5cab", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"];

function hexToRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 0..1 arasındaki değeri skala üzerinde renge çevirir. */
export function rampColor(ramp: string[], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(ramp.length - 2, Math.floor(x));
  const f = x - i;
  const a = hexToRgb(ramp[i]);
  const b = hexToRgb(ramp[i + 1]);
  const c = a.map((v, k) => Math.round(v + (b[k] - v) * f));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export const METRICS: Record<string, { label: string; unit: string; digits: number }> = {
  ele: { label: t("Yükseklik"), unit: "m", digits: 0 },
  speed: { label: t("Hız"), unit: t("km/sa"), digits: 1 },
  hr: { label: t("Nabız"), unit: t("atım/dk"), digits: 0 },
  cad: { label: t("Kadans"), unit: t("dev/dk"), digits: 0 },
  power: { label: t("Güç"), unit: "W", digits: 0 },
  temp: { label: t("Sıcaklık"), unit: "°C", digits: 1 },
};

export const ACTIVITIES: { id: import("./api").Activity; label: string; icon: string }[] = [
  { id: "walk", label: "Yürüyüş", icon: "🚶" },
  { id: "run", label: "Koşu", icon: "🏃" },
  { id: "bike", label: "Bisiklet", icon: "🚴" },
  { id: "car", label: "Araç", icon: "🚗" },
  { id: "unknown", label: "Bilinmiyor", icon: "•" },
];

export function activityOf(id: string) {
  return ACTIVITIES.find((a) => a.id === id) ?? ACTIVITIES[ACTIVITIES.length - 1];
}

/** "Kadıköy → Beşiktaş" ya da tek yerse "Kadıköy". Başlangıç/bitiş adlandırılmış
 * bir yerin yarıçapındaysa o ad kullanılır ("Ev → İş"). */
export function placeLabel(s: {
  startPlace: string | null;
  endPlace: string | null;
  start?: [number, number] | null;
  end?: [number, number] | null;
}): string | null {
  const a = (s.start && namedPlaceAt(s.start[0], s.start[1])?.name) || s.startPlace;
  const b = (s.end && namedPlaceAt(s.end[0], s.end[1])?.name) || s.endPlace;
  if (a && b && a !== b) return `${a} → ${b}`;
  return a ?? b ?? null;
}
