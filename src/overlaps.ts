/**
 * Çakışan kayıtlar: zaman aralıkları örtüşen kayıtlar (ör. aynı yürüyüşü iki
 * cihazla kaydetmek). Uzun kayıtlarda yalnızca ikisinin de verisi olan saatler
 * sayılır; ortak süre en az 30 dakikaysa çakışma kabul edilir.
 */

import type { FileSummary } from "./api";

const HOUR = 3_600_000;
export const MIN_OVERLAP_MS = 30 * 60_000;

export interface Overlap {
  path: string;
  ms: number;
}

const hourSets = new WeakMap<FileSummary, Set<number> | null>();

function hoursOf(s: FileSummary): Set<number> | null {
  let set = hourSets.get(s);
  if (set !== undefined) return set;
  const h = Array.isArray(s.hours) ? s.hours : [];
  set = h.length ? new Set(h.map((x) => Math.floor(x[0] / HOUR) * HOUR)) : null;
  hourSets.set(s, set);
  return set;
}

function sharedMs(a: FileSummary, b: FileSummary): number {
  const a0 = a.stats.startTime!;
  const a1 = a.stats.endTime!;
  const b0 = b.stats.startTime!;
  const b1 = b.stats.endTime!;
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  if (hi - lo < MIN_OVERLAP_MS) return 0;
  const ha = hoursOf(a);
  const hb = hoursOf(b);
  if (!ha || !hb) return hi - lo;
  const [small, big] = ha.size <= hb.size ? [ha, hb] : [hb, ha];
  let ms = 0;
  for (const h of small) {
    if (h + HOUR <= lo || h >= hi || !big.has(h)) continue;
    ms += Math.min(hi, h + HOUR) - Math.max(lo, h);
  }
  return ms;
}

/** Her kayıt için onunla çakışan kayıtlar (ortak süreye göre çoktan aza). */
export function findOverlaps(summaries: readonly FileSummary[]): Map<string, Overlap[]> {
  const timed = summaries
    .filter((s) => s.stats.startTime != null && s.stats.endTime != null && s.stats.endTime > s.stats.startTime)
    .sort((a, b) => a.stats.startTime! - b.stats.startTime!);
  const out = new Map<string, Overlap[]>();
  const add = (p: string, o: Overlap) => {
    const l = out.get(p);
    if (l) l.push(o);
    else out.set(p, [o]);
  };
  // Süpürme: başlangıca göre sıralı; etkin listede bitişi henüz gelmemiş kayıtlar.
  let active: FileSummary[] = [];
  for (const s of timed) {
    const t = s.stats.startTime!;
    active = active.filter((x) => x.stats.endTime! - t >= MIN_OVERLAP_MS);
    for (const x of active) {
      if (x.path === s.path) continue;
      const ms = sharedMs(x, s);
      if (ms >= MIN_OVERLAP_MS) {
        add(x.path, { path: s.path, ms });
        add(s.path, { path: x.path, ms });
      }
    }
    active.push(s);
  }
  for (const l of out.values()) l.sort((a, b) => b.ms - a.ms);
  return out;
}
