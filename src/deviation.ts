/** İki iz arasındaki sapma (plan ile gerçekleşen karşılaştırması). */

type P = [number, number]; // [boylam, enlem]

export interface Deviation {
  /** En büyük uzaklık (m) ve yeri. */
  maxM: number;
  maxAt: P | null;
  /** `other` izinin `ref`ten eşikten uzak kısmının uzunluğu (m) ve oranı. */
  offM: number;
  offShare: number;
  /** Eşikten uzak bölümler: `other` boyunca başlangıç/bitiş mesafesi ve orta noktası. */
  sections: { fromM: number; toM: number; maxM: number; at: P }[];
}

const KY = 110_574;
const kx = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** `p` noktasının `a`–`b` doğru parçasına uzaklığı (m, yerel düzlem). */
function segDist(p: P, a: P, b: P): number {
  const k = kx(p[1]);
  const ax = (a[0] - p[0]) * k;
  const ay = (a[1] - p[1]) * KY;
  const bx = (b[0] - p[0]) * k;
  const by = (b[1] - p[1]) * KY;
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

const CELL = 0.02; // ~2 km

/** `other` izinin her noktasının `ref` izine uzaklığından sapma özeti. */
export function deviation(ref: P[], other: P[], thresholdM = 200): Deviation {
  // `ref` parçaları ızgaraya dizilir; arama yakın hücrelerle sınırlı.
  const grid = new Map<string, number[]>();
  const cellOf = (p: P) => [Math.floor(p[0] / CELL), Math.floor(p[1] / CELL)];
  for (let i = 1; i < ref.length; i++) {
    const [x0, y0] = cellOf(ref[i - 1]);
    const [x1, y1] = cellOf(ref[i]);
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
        const k = `${x}:${y}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(i);
      }
  }
  // Uzak noktalar için kaba yedek: seyreltilmiş parçalar üzerinde tam tarama.
  const stride = Math.max(1, Math.ceil(ref.length / 1500));
  const coarse: number[] = [];
  for (let i = stride; i < ref.length; i += stride) coarse.push(i);
  const RINGS = 6;
  const nearest = (p: P): number => {
    const [cx, cy] = cellOf(p);
    let best = Infinity;
    const visit = (x: number, y: number) => {
      for (const i of grid.get(`${x}:${y}`) ?? []) best = Math.min(best, segDist(p, ref[i - 1], ref[i]));
    };
    for (let r = 0; r <= RINGS; r++) {
      if (r === 0) visit(cx, cy);
      else {
        for (let x = cx - r; x <= cx + r; x++) {
          visit(x, cy - r);
          visit(x, cy + r);
        }
        for (let y = cy - r + 1; y <= cy + r - 1; y++) {
          visit(cx - r, y);
          visit(cx + r, y);
        }
      }
      // Bulunan, bir sonraki halkadaki her şeyden yakınsa dur.
      // Doğu-batı yönünde hücre kx(enlem) metre: yüksek enlemlerde KY'den çok kısa.
      if (best <= r * CELL * Math.min(KY, kx(p[1])) * 0.9) return best;
    }
    // Halkalarda kanıtlanamadı (en yakın parça halkaların dışında olabilir): kaba tarama da yapılır.
    for (const i of coarse) best = Math.min(best, segDist(p, ref[i - stride], ref[i]));
    return best;
  };
  const out: Deviation = { maxM: 0, maxAt: null, offM: 0, offShare: 0, sections: [] };
  if (ref.length < 2 || other.length === 0) return out;
  let along = 0;
  let total = 0;
  let cur: Deviation["sections"][number] | null = null;
  other.forEach((p, i) => {
    const step =
      i > 0 ? Math.hypot((p[0] - other[i - 1][0]) * kx(p[1]), (p[1] - other[i - 1][1]) * KY) : 0;
    along += step;
    total += step;
    const d = nearest(p);
    if (d > out.maxM) {
      out.maxM = d;
      out.maxAt = p;
    }
    if (d > thresholdM) {
      if (i > 0) out.offM += step;
      if (!cur) cur = { fromM: along, toM: along, maxM: d, at: p };
      cur.toM = along;
      if (d > cur.maxM) {
        cur.maxM = d;
        cur.at = p;
      }
    } else if (cur) {
      out.sections.push(cur);
      cur = null;
    }
  });
  if (cur) out.sections.push(cur);
  out.offShare = total > 0 ? out.offM / total : 0;
  // Gürültü: 100 m'den kısa bölümler atılır.
  out.sections = out.sections.filter((s) => s.toM - s.fromM >= 100 || s.maxM > thresholdM * 3);
  return out;
}
