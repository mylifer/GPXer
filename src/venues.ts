import type { FileSummary, Venue } from "./api";
import { dayKey, tzOf } from "./format";

/** Ziyaret defterine giren en kısa durak. */
export const VISIT_MIN_MS = 10 * 60_000;

/** Birbirine ~100 m'den yakın duraklar aynı hücrede: mekân bir kez sorulur. */
export const cellOf = (lon: number, lat: number) => `${lon.toFixed(3)},${lat.toFixed(3)}`;

export interface VisitStop {
  cell: string;
  lon: number;
  lat: number;
  day: string;
  durationMs: number;
}

/** Kayıtlardaki uzunca duraklar (hücre ve gün ile). */
export function visitStops(summaries: readonly FileSummary[]): VisitStop[] {
  const out: VisitStop[] = [];
  for (const s of summaries) {
    const tz = tzOf(s);
    for (const st of s.stops ?? []) {
      if (st.durationMs < VISIT_MIN_MS) continue;
      out.push({ cell: cellOf(st.lon, st.lat), lon: st.lon, lat: st.lat, day: dayKey(st.start, tz), durationMs: st.durationMs });
    }
  }
  return out;
}

export interface VenueVisits {
  name: string;
  kind: string;
  lon: number;
  lat: number;
  /** Farklı günlerde ziyaret sayısı. */
  visits: number;
  totalMs: number;
  first: string;
  last: string;
}

/** Duraklar ve hücrelerin mekânlarından ziyaret defteri: en çok gidilen önce. */
export function venueBook(stops: readonly VisitStop[], venues: ReadonlyMap<string, Venue | null>): VenueVisits[] {
  const m = new Map<string, VenueVisits & { days: Set<string> }>();
  for (const st of stops) {
    const v = venues.get(st.cell);
    if (!v) continue;
    // Zincirlerin farklı şubeleri ayrı satır (≈1 km'lik hücre).
    const key = `${v.name}\u0000${v.kind}\u0000${Math.round(st.lon * 100)},${Math.round(st.lat * 100)}`;
    let e = m.get(key);
    if (!e) {
      e = { name: v.name, kind: v.kind, lon: st.lon, lat: st.lat, visits: 0, totalMs: 0, first: st.day, last: st.day, days: new Set() };
      m.set(key, e);
    }
    e.days.add(st.day);
    e.totalMs += st.durationMs;
    if (st.day < e.first) e.first = st.day;
    if (st.day > e.last) e.last = st.day;
  }
  return [...m.values()]
    .map(({ days, ...e }) => ({ ...e, visits: days.size }))
    .sort((a, b) => b.visits - a.visits || b.totalMs - a.totalMs || a.name.localeCompare(b.name, "tr-TR"));
}

const ICONS: Record<string, string> = {
  cafe: "☕",
  restaurant: "🍽",
  fast_food: "🍔",
  bar: "🍷",
  pub: "🍺",
  bakery: "🥐",
  museum: "🏛",
  park: "🌳",
  place_of_worship: "🕌",
  hotel: "🏨",
  lodging: "🏨",
  shop: "🛍",
  grocery: "🛒",
  supermarket: "🛒",
  fuel: "⛽",
  hospital: "🏥",
  school: "🏫",
  college: "🎓",
  university: "🎓",
  beach: "🏖",
  attraction: "📍",
  railway: "🚉",
  harbor: "⚓",
  ferry_terminal: "⛴",
  aerialway: "🚡",
  airport: "✈",
  cinema: "🎬",
  theatre: "🎭",
  stadium: "🏟",
};
export const venueIcon = (kind: string) => ICONS[kind] ?? "📍";
