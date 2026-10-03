/** Basit coğrafi yardımcılar (düzlem yaklaşımı; kısa mesafeler için yeterli). */

export type BBox = [number, number, number, number];

export function metersBetween(a: [number, number], b: [number, number]): number {
  const kx = 111_320 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180);
  return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110_574);
}

function inside(p: [number, number], b: BBox) {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/** Doğru parçası dikdörtgeni kesiyor mu (Liang–Barsky). */
function segmentHits(a: [number, number], c: [number, number], b: BBox): boolean {
  if (inside(a, b) || inside(c, b)) return true;
  const dx = c[0] - a[0];
  const dy = c[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number) => {
    if (p === 0) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return (
    clip(-dx, a[0] - b[0]) && clip(dx, b[2] - a[0]) && clip(-dy, a[1] - b[1]) && clip(dy, b[3] - a[1]) && t0 <= t1
  );
}

/** İz dikdörtgenden geçiyor mu. */
export function linesHitBox(lines: [number, number][][], box: BBox, bbox?: BBox | null): boolean {
  // Haritanın komşu dünya kopyasında seçilen alan ±180°'nin ötesine taşabilir;
  // 180°'yi geçen izler de sürekli boylamlarla denetlenir.
  const u = unwrapLines(lines, bbox ?? null);
  return [0, -360, 360].some((k) => hitsOnce(u.lines, [box[0] + k, box[1], box[2] + k, box[3]], u.bbox));
}

function hitsOnce(lines: [number, number][][], b: BBox, bbox: BBox | null): boolean {
  if (bbox && (bbox[2] < b[0] || bbox[0] > b[2] || bbox[3] < b[1] || bbox[1] > b[3])) return false;
  for (const line of lines) {
    if (line.length === 1 && inside(line[0], b)) return true;
    for (let i = 0; i + 1 < line.length; i++) if (segmentHits(line[i], line[i + 1], b)) return true;
  }
  return false;
}

/** Çizgi boyunca eşit aralıklı `n` nokta (tüm segmentler uç uca). */
export function resample(lines: [number, number][][], n: number): [number, number][] | null {
  const pts = lines.flat();
  if (pts.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + metersBetween(pts[i - 1], pts[i]));
  const total = cum[cum.length - 1];
  if (total <= 0) return null;
  const out: [number, number][] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < pts.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.min(1, Math.max(0, (d - cum[j]) / seg));
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
  }
  return out;
}

/** Boylamı bir öncekine en yakın dünya kopyasına taşır (±180° boylamını
 * geçen iz, haritayı boydan boya kesen bir çizgi olarak çizilmesin). */
export const nearLon = (lon: number, prev: number) => lon + 360 * Math.round((prev - lon) / 360);

type Line = [number, number][];
const unwrapCache = new WeakMap<Line[], { lines: Line[]; bbox: [number, number, number, number] | null }>();

/** Çizgileri sürekli boylamlarla döndürür; ±180°'yi geçmeyen (neredeyse
 * tüm) kayıtlarda aynı dizi ve sınır kutusu kullanılır. */
export function unwrapLines(lines: Line[], bbox: [number, number, number, number] | null) {
  const crosses = lines.some((l) => l.some((p, i) => i > 0 && Math.abs(p[0] - l[i - 1][0]) > 180));
  if (!crosses) return { lines, bbox };
  const hit = unwrapCache.get(lines);
  if (hit) return hit;
  let bb: [number, number, number, number] | null = null;
  const out = lines.map((l) => {
    let prev = l[0]?.[0] ?? 0;
    return l.map(([x, y]): [number, number] => {
      const lon = nearLon(x, prev);
      prev = lon;
      bb = bb ? [Math.min(bb[0], lon), Math.min(bb[1], y), Math.max(bb[2], lon), Math.max(bb[3], y)] : [lon, y, lon, y];
      return [lon, y];
    });
  });
  const res = { lines: out, bbox: bb };
  unwrapCache.set(lines, res);
  return res;
}
