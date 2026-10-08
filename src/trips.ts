/** Kayıtlardan geziler: "ev" (günlerin çoğunun başladığı yer) çıkarılır;
 * evden belirgin biçimde uzaklaşan ve aralarında uzun boşluk olmayan ardışık
 * kayıtlar bir gezi sayılır. Her gün evden başlayan işe gidiş-gelişler gezi
 * olmaz. */
import type { FileSummary } from "./api";
import { dayKey, dayRangeTr, tzOf } from "./format";

/** Evden en az bu kadar uzaklaşan kayıt gezi kaydıdır (m). */
export const AWAY_M = 50_000;
/** Gezideki iki kayıt arasında en çok bu kadar boşluk olabilir (ms). */
export const MAX_GAP_MS = 48 * 3_600_000;

export interface Trip {
  key: string;
  /** "Marmaris gezisi · 9–14.07.24" */
  label: string;
  paths: string[];
  start: number;
  end: number;
}

type Pt = [number, number];

function distM([lo1, la1]: Pt, [lo2, la2]: Pt): number {
  const r = Math.PI / 180;
  const a = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a));
}

/** Ev: günün ilk kaydının başladığı yerlerden en sık olanı (~10 km'lik hücre). */
export function homeOf(list: FileSummary[]): Pt | null {
  const firstOfDay = new Map<string, FileSummary>();
  for (const s of list) {
    if (s.stats.startTime == null || !s.start) continue;
    const d = dayKey(s.stats.startTime, tzOf(s));
    const cur = firstOfDay.get(d);
    if (!cur || s.stats.startTime < cur.stats.startTime!) firstOfDay.set(d, s);
  }
  const cells = new Map<string, { n: number; sum: Pt }>();
  for (const s of firstOfDay.values()) {
    const [lo, la] = s.start!;
    const k = `${Math.round(lo * 10)},${Math.round(la * 10)}`;
    const c = cells.get(k) ?? { n: 0, sum: [0, 0] };
    c.n++;
    c.sum = [c.sum[0] + lo, c.sum[1] + la];
    cells.set(k, c);
  }
  let best: { n: number; sum: Pt } | null = null;
  for (const c of cells.values()) if (!best || c.n > best.n) best = c;
  // Tek günlük veriyle ev söylenemez.
  if (!best || best.n < 2) return null;
  return [best.sum[0] / best.n, best.sum[1] / best.n];
}

/** Kaydın evden en uzak noktasının uzaklığı ve o noktanın adı (yaklaşık: uçlar ve kutu köşeleri). */
function farthest(s: FileSummary, home: Pt): { d: number; place: string | null } {
  const cand: [Pt | null, string | null][] = [
    [s.start, s.startPlace],
    [s.end, s.endPlace],
  ];
  const b = s.stats.bbox;
  if (b)
    for (const p of [
      [b[0], b[1]],
      [b[0], b[3]],
      [b[2], b[1]],
      [b[2], b[3]],
    ] as Pt[])
      cand.push([p, null]);
  let out = { d: 0, place: null as string | null };
  for (const [p, name] of cand) {
    if (!p) continue;
    const d = distM(p, home);
    if (d > out.d || (name && !out.place && d > out.d * 0.8)) out = { d: Math.max(d, out.d), place: name ?? out.place };
  }
  // Adı olmayan köşe en uzaksa, kaydın yer dökümünden en uzak ad.
  if (!out.place) out.place = s.endPlace ?? s.startPlace;
  return out;
}

/** Gezi adı için yer: gezideki kayıtların evden en uzak adlı yeri. */
function tripPlace(items: FileSummary[], home: Pt): string | null {
  let best: { d: number; name: string } | null = null;
  for (const s of items)
    for (const [p, name] of [
      [s.start, s.startPlace],
      [s.end, s.endPlace],
    ] as [Pt | null, string | null][]) {
      if (!p || !name) continue;
      const d = distM(p, home);
      if (!best || d > best.d) best = { d, name };
    }
  return best?.name ?? null;
}

/** Seçili kayıtlar için gezi adı: evden en uzak yer ve tarih aralığı. Ev
 * bilinmiyorsa ilk kaydın başladığı yerden en uzak yer. */
export function tripName(list: FileSummary[], home: Pt | null = null): string {
  const dated = list.filter((s) => s.stats.startTime != null).sort((a, b) => a.stats.startTime! - b.stats.startTime!);
  const from = home ?? dated[0]?.start ?? list[0]?.start;
  const place = from ? tripPlace(list, from) : null;
  if (!dated.length) return place ? `${place} gezisi` : "Gezi";
  const tz = tzOf(dated[0]);
  const end = Math.max(...dated.map((s) => s.stats.endTime ?? s.stats.startTime!));
  return `${place ? `${place} gezisi` : "Gezi"} · ${dayRangeTr(dayKey(dated[0].stats.startTime!, tz), dayKey(end, tz))}`;
}

/** Kütüphanedeki geziler (tarih sırasıyla). */
export function detectTrips(list: FileSummary[]): Trip[] {
  const home = homeOf(list);
  if (!home) return [];
  const dated = list.filter((s) => s.stats.startTime != null).sort((a, b) => a.stats.startTime! - b.stats.startTime!);
  const trips: Trip[] = [];
  let cur: FileSummary[] = [];
  let curEnd = -Infinity;
  const flush = () => {
    if (cur.length) {
      const start = cur[0].stats.startTime!;
      const end = Math.max(...cur.map((s) => s.stats.endTime ?? s.stats.startTime!));
      trips.push({ key: `trip:${start}`, label: tripName(cur, home), paths: cur.map((s) => s.path), start, end });
    }
    cur = [];
  };
  for (const s of dated) {
    const away = farthest(s, home).d >= AWAY_M;
    if (!away) {
      flush();
      continue;
    }
    if (cur.length && s.stats.startTime! - curEnd > MAX_GAP_MS) flush();
    cur.push(s);
    curEnd = Math.max(curEnd, s.stats.endTime ?? s.stats.startTime!);
  }
  flush();
  return trips;
}
