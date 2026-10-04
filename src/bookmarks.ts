import type { Bookmark, FileSummary } from "./api";
import { metersBetween } from "./geo";

/** Yer imine gidilmiş mi: herhangi bir iz `radiusM` yakınından geçtiyse
 * ilk geçiş anı (zamansızsa 0). */
export function visitedBookmarks(marks: Bookmark[], files: FileSummary[], radiusM = 300): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of marks) {
    const p: [number, number] = [b.lon, b.lat];
    let best: number | null = null;
    for (const s of files) {
      s.lines.forEach((line, li) =>
        line.forEach((q, i) => {
          if (Math.abs(q[1] - b.lat) > 0.01 || metersBetween(q, p) > radiusM) return;
          const t = s.times[li]?.[i] ?? 0;
          // Zamansız geçiş (0) zamanlı bir geçişe yer bırakır.
          if (best == null || (t && (best === 0 || t < best))) best = t;
        }),
      );
    }
    if (best != null) out.set(b.id, best);
  }
  return out;
}
