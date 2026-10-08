/** "Burada ne zaman bulundum?": kayıtların bir noktanın yakınından geçtiği
 * anlar. Aynı kayıtta 30 dakikadan uzun arayla yeniden geçiş ayrı sayılır. */
import type { FileSummary } from "./api";

export interface Pass {
  path: string;
  /** Noktaya en yakın olunan an (yoksa null: zamansız kayıt). */
  t: number | null;
  /** En yakın uzaklık (m). */
  distM: number;
}

const SEP_MS = 30 * 60_000;

function distM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const k = 111_320;
  const x = (lon2 - lon1) * k * Math.cos((lat1 * Math.PI) / 180);
  const y = (lat2 - lat1) * k;
  return Math.hypot(x, y);
}

/** Noktaya en yakın uzaklık: bölümlere (iki nokta arası) göre, seyrek kayıtta da doğru. */
function segDist(lon: number, lat: number, a: [number, number], b: [number, number]): { d: number; f: number } {
  const k = 111_320;
  const c = Math.cos((lat * Math.PI) / 180);
  const ax = (a[0] - lon) * k * c;
  const ay = (a[1] - lat) * k;
  const bx = (b[0] - lon) * k * c;
  const by = (b[1] - lat) * k;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const f = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return { d: Math.hypot(ax + f * dx, ay + f * dy), f };
}

export function passesNear(list: FileSummary[], lon: number, lat: number, radiusM: number): Pass[] {
  const out: Pass[] = [];
  const dLat = radiusM / 111_320;
  const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  for (const s of list) {
    const b = s.stats.bbox;
    if (b && (lon < b[0] - dLon || lon > b[2] + dLon || lat < b[1] - dLat || lat > b[3] + dLat)) continue;
    let cur: Pass | null = null;
    let lastNear = -Infinity;
    s.lines.forEach((line, li) => {
      const times = s.times[li] ?? [];
      for (let i = 0; i < line.length; i++) {
        const a = line[i];
        const b2 = line[i + 1] ?? a;
        // Hızlı eleme: iki uç da kutunun aynı dışındaysa.
        if ((a[0] < lon - dLon && b2[0] < lon - dLon) || (a[0] > lon + dLon && b2[0] > lon + dLon)) continue;
        if ((a[1] < lat - dLat && b2[1] < lat - dLat) || (a[1] > lat + dLat && b2[1] > lat + dLat)) continue;
        const { d, f } = segDist(lon, lat, a, b2);
        if (d > radiusM) continue;
        const ta = times[i] ?? null;
        const tb = times[i + 1] ?? ta;
        const t = ta != null && tb != null ? ta + (tb - ta) * f : (ta ?? s.stats.startTime);
        const tt = t ?? 0;
        if (cur && (t == null || tt - lastNear <= SEP_MS)) {
          if (d < cur.distM) {
            cur.distM = d;
            cur.t = t;
          }
        } else {
          cur = { path: s.path, t, distM: d };
          out.push(cur);
        }
        lastNear = tt;
      }
    });
  }
  return out.sort((a, b) => (b.t ?? -Infinity) - (a.t ?? -Infinity));
}

export { distM as metersBetween };
