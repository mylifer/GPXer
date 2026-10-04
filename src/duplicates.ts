/**
 * Neredeyse aynı kayıtlar: aynı yolculuğun farklı adla ya da biraz farklı
 * kesilmiş kopyaları ("Road trip", "Road trip kopyası", "…gpx 2"). Birebir aynı
 * içerik zaten içe aktarılırken yakalanıyor; burada kapsananlar bulunur.
 *
 * Bir kayıt, zaman aralığının ve verisi olan saatlerinin en az %95'i başka bir
 * kayıtta da varsa ve o kayıt en az onun yarısı kadar sık nokta içeriyorsa
 * fazlalıktır. Aynı saatte saniyeler süren ayrı kayıtlar zaman aralığı
 * denetimiyle, aynı dönemin farklı sıklıkta iki kaydı (seyrek konum geçmişi ile
 * yola oturtulmuş sürümü) kapsama oranıyla ayrılır.
 */

import type { FileSummary } from "./api";
import { hoursOf } from "./overlaps";

const COVER = 0.95;
/** Kapsayan kaydın nokta sıklığı en az bu oranda olmalı (daha seyrek bir
 * kayıt, ayrıntılı kaydın kopyası sayılmaz). */
const DENSITY = 0.5;

export interface DuplicateGroup {
  /** Önerilen: tutulacak kayıtlar (başka bir kayıtça kapsanmayanlar). */
  keep: string[];
  /** Gruptaki tüm kayıtlar; önce tutulacaklar, iyiden kötüye. */
  paths: string[];
}

const span = (s: FileSummary) => (s.stats.endTime ?? 0) - (s.stats.startTime ?? 0);

/** `b`, `a` tarafından kapsanıyor mu? */
function covers(a: FileSummary, b: FileSummary): boolean {
  const b0 = b.stats.startTime!;
  const b1 = b.stats.endTime!;
  const lo = Math.max(a.stats.startTime!, b0);
  const hi = Math.min(a.stats.endTime!, b1);
  if (b1 > b0 && (hi - lo) / (b1 - b0) < COVER) return false;
  if (b1 === b0 && (b0 < a.stats.startTime! || b0 > a.stats.endTime!)) return false;
  const ha = hoursOf(a);
  const hb = hoursOf(b);
  if (ha && hb && hb.size > 0) {
    let shared = 0;
    for (const h of hb) if (ha.has(h)) shared++;
    if (shared / hb.size < COVER) return false;
  }
  const density = (s: FileSummary) => s.stats.pointCount / Math.max(1, hoursOf(s)?.size ?? span(s) / 3_600_000);
  return density(a) >= DENSITY * density(b);
}

/** İyi kopya önce: daha çok nokta, daha uzun süre, sonra yol (kararlı sıra). */
const better = (a: FileSummary, b: FileSummary) =>
  b.stats.pointCount - a.stats.pointCount || span(b) - span(a) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Kopya grupları; her grupta en az iki kayıt. */
export function findDuplicates(summaries: readonly FileSummary[]): DuplicateGroup[] {
  const timed = summaries
    .filter((s) => s.stats.startTime != null && s.stats.endTime != null)
    .sort((a, b) => a.stats.startTime! - b.stats.startTime!);
  // Birleşim-bul: kapsama ilişkisiyle bağlı kayıtlar bir grup.
  const parent = new Map<string, string>();
  const find = (p: string): string => {
    let r = p;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(p, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  const covered = new Set<string>();
  for (const s of timed) parent.set(s.path, s.path);
  // Süpürme: zaman aralıkları örtüşen çiftler.
  let active: FileSummary[] = [];
  for (const s of timed) {
    active = active.filter((x) => x.stats.endTime! >= s.stats.startTime!);
    for (const x of active) {
      const xs = covers(x, s);
      const sx = covers(s, x);
      if (!xs && !sx) continue;
      union(x.path, s.path);
      // Karşılıklı kapsamada (birebir aynı dönem) yalnızca kötüsü fazlalık.
      if (xs && sx) covered.add(better(x, s) < 0 ? s.path : x.path);
      else covered.add(xs ? s.path : x.path);
    }
    active.push(s);
  }
  const groups = new Map<string, FileSummary[]>();
  for (const s of timed) {
    const r = find(s.path);
    const g = groups.get(r);
    if (g) g.push(s);
    else groups.set(r, [s]);
  }
  const out: DuplicateGroup[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort(better);
    let keep = g.filter((s) => !covered.has(s.path));
    if (keep.length === 0) keep = [g[0]];
    const rest = g.filter((s) => !keep.includes(s));
    out.push({ keep: keep.map((s) => s.path), paths: [...keep, ...rest].map((s) => s.path) });
  }
  return out.sort((a, b) => b.paths.length - a.paths.length);
}
