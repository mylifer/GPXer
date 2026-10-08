import type { FileMeta } from "./api";
import { dayBuckets } from "./days";
import type { FileEntry } from "./types";

export interface PersonStats {
  name: string;
  records: number;
  distanceM: number;
  /** Birlikte geçirilen farklı günler. */
  days: number;
  first: string;
  last: string;
}

/** Kayıtlarda birlikte olunan kişiler: en çok gün geçirilen önce. */
export function peopleStats(files: FileEntry[], meta: Record<string, FileMeta>): PersonStats[] {
  const m = new Map<string, { records: number; distanceM: number; days: Set<string> }>();
  for (const f of files) {
    const people = meta[f.summary.path]?.people;
    if (!people?.length) continue;
    const days = dayBuckets(f.summary).map((b) => b.day);
    for (const p of people) {
      const s = m.get(p) ?? { records: 0, distanceM: 0, days: new Set<string>() };
      s.records++;
      s.distanceM += f.summary.stats.distanceM;
      for (const d of days) s.days.add(d);
      m.set(p, s);
    }
  }
  return [...m]
    .map(([name, s]) => {
      const d = [...s.days].sort();
      return { name, records: s.records, distanceM: s.distanceM, days: d.length, first: d[0] ?? "", last: d[d.length - 1] ?? "" };
    })
    .sort((a, b) => b.days - a.days || b.records - a.records || a.name.localeCompare(b.name, "tr-TR"));
}
