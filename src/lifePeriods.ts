import type { FileSummary } from "./api";
import { dayKey, tzOf } from "./format";

type Pt = [number, number];

/** Bir dönem: aynı yerde (≈2 km) yaşanan aylar. */
export interface LifePeriod {
  /** "2019-03" */
  from: string;
  to: string;
  months: number;
  lon: number;
  lat: number;
  /** Başlangıç yerlerinden en sık geçen ad (yoksa null). */
  place: string | null;
}

/** Ayın evi sayılmak için o ayda bu kadar gün aynı hücreden başlanmalı. */
const MIN_DAYS = 4;
/** ... ve günlerin en az bu kadarı. */
const MIN_SHARE = 0.4;
/** Dönem içinde bu kadar ay başka yerde (gezi, eksik kayıt) geçebilir. */
const MAX_BREAK = 2;
/** Bundan kısa dönemler listelenmez. */
const MIN_MONTHS = 2;

const cellOf = ([lo, la]: Pt) => `${Math.round(lo * 50)},${Math.round(la * 50)}`;
const monthIdx = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthKey = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;

/** Günün ilk kaydının başladığı yerlerden ay ay "ev" ve ardışık aylardan
 * yaşam dönemleri (eskiden yeniye). */
export function lifePeriods(list: readonly FileSummary[]): LifePeriod[] {
  const firstOfDay = new Map<string, FileSummary>();
  for (const s of list) {
    if (s.stats.startTime == null || !s.start) continue;
    const d = dayKey(s.stats.startTime, tzOf(s));
    const cur = firstOfDay.get(d);
    if (!cur || s.stats.startTime < cur.stats.startTime!) firstOfDay.set(d, s);
  }
  // Ay → hücre → (gün sayısı, nokta toplamı, yer adları)
  const months = new Map<string, Map<string, { n: number; sum: Pt; names: Map<string, number> }>>();
  const daysIn = new Map<string, number>();
  for (const [day, s] of firstOfDay) {
    const m = day.slice(0, 7);
    daysIn.set(m, (daysIn.get(m) ?? 0) + 1);
    const cells = months.get(m) ?? new Map();
    months.set(m, cells);
    const k = cellOf(s.start!);
    const c = cells.get(k) ?? { n: 0, sum: [0, 0] as Pt, names: new Map<string, number>() };
    c.n++;
    c.sum = [c.sum[0] + s.start![0], c.sum[1] + s.start![1]];
    if (s.startPlace) c.names.set(s.startPlace, (c.names.get(s.startPlace) ?? 0) + 1);
    cells.set(k, c);
  }
  // Her ayın evi (yeterince belirginse).
  const homes: { m: number; cell: string; n: number; sum: Pt; names: Map<string, number> }[] = [];
  for (const [m, cells] of months) {
    let best: { cell: string; n: number; sum: Pt; names: Map<string, number> } | null = null;
    for (const [cell, c] of cells) if (!best || c.n > best.n) best = { cell, ...c };
    if (best && best.n >= MIN_DAYS && best.n / daysIn.get(m)! >= MIN_SHARE) homes.push({ m: monthIdx(m), ...best });
  }
  homes.sort((a, b) => a.m - b.m);
  // Komşu hücreler (sınırda oynayan ev) aynı yer sayılır.
  const near = (a: string, b: string) => {
    const [ax, ay] = a.split(",").map(Number);
    const [bx, by] = b.split(",").map(Number);
    return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1;
  };
  const out: LifePeriod[] = [];
  let cur: { from: number; to: number; cell: string; n: number; sum: Pt; names: Map<string, number> } | null = null;
  const flush = () => {
    if (!cur) return;
    const months = cur.to - cur.from + 1;
    if (months >= MIN_MONTHS) {
      const place = [...cur.names].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      out.push({ from: monthKey(cur.from), to: monthKey(cur.to), months, lon: cur.sum[0] / cur.n, lat: cur.sum[1] / cur.n, place });
    }
    cur = null;
  };
  for (const h of homes) {
    if (cur && near(cur.cell, h.cell) && h.m - cur.to <= MAX_BREAK + 1) {
      cur.to = h.m;
      cur.n += h.n;
      cur.sum = [cur.sum[0] + h.sum[0], cur.sum[1] + h.sum[1]];
      for (const [k, v] of h.names) cur.names.set(k, (cur.names.get(k) ?? 0) + v);
      continue;
    }
    flush();
    cur = { from: h.m, to: h.m, cell: h.cell, n: h.n, sum: h.sum, names: new Map(h.names) };
  }
  flush();
  return out;
}

/** O andaki ev: zamanı kapsayan (ya da en yakın önceki) dönemin yeri. */
export function homeAt(periods: readonly LifePeriod[], t: number): Pt | null {
  if (!periods.length) return null;
  // Dönemler yerel günlerden kurulur: ay da yerel saate göre.
  const d = new Date(t);
  const m = d.getFullYear() * 12 + d.getMonth();
  let best = periods[0];
  for (const p of periods) if (monthIdx(p.from) <= m) best = p;
  return [best.lon, best.lat];
}
