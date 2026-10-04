import type { FileSummary } from "./api";
import { metersBetween } from "./geo";

export interface Leg {
  path: string;
  /** A'dan ayrılış ve B'ye varış anı. */
  leave: number;
  arrive: number;
  /** A'dan B'ye iz boyunca mesafe (m). */
  distanceM: number;
}

/** A'dan B'ye yapılan yolculuklar: iz A'nın `radiusM` yakınından geçip
 * daha sonra B'nin yakınına varıyorsa. A bölgesindeki son nokta ayrılış, B
 * bölgesine ilk giriş varış sayılır; bir kayıtta birden çok gidiş olabilir. */
export function legsBetween(
  files: FileSummary[],
  a: [number, number],
  b: [number, number],
  radiusM: number,
): Leg[] {
  const out: Leg[] = [];
  for (const s of files) {
    let leave: number | null = null;
    let distSinceLeave = 0;
    let prev: [number, number] | null = null;
    s.lines.forEach((line, li) => {
      const times = s.times[li];
      line.forEach((p, i) => {
        const t = times?.[i];
        if (prev) distSinceLeave += metersBetween(prev, p);
        prev = p;
        if (t == null) return;
        if (metersBetween(p, a) <= radiusM) {
          leave = t;
          distSinceLeave = 0;
        } else if (leave != null && metersBetween(p, b) <= radiusM) {
          out.push({ path: s.path, leave, arrive: t, distanceM: distSinceLeave });
          leave = null;
        }
      });
    });
  }
  return out.sort((x, y) => y.leave - x.leave);
}
