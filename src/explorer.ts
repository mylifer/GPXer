import type { FileSummary } from "./api";

/** Keşif kareleri: dünya 14. düzey harita karolarına (Türkiye'de ~1,8 km)
 * bölünür; izin geçtiği kareler “keşfedilmiş” sayılır. */
export const EXPLORER_Z = 14;
const N = 2 ** EXPLORER_Z;

const tx = (lon: number) => Math.floor(((lon + 180) / 360) * N);
const ty = (lat: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N);
};
const lonOf = (x: number) => (x / N) * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / N))) * 180) / Math.PI;

const cache = new WeakMap<FileSummary, Set<number>>();
const key = (x: number, y: number) => x * N + y;

/** Kaydın geçtiği kareler (ardışık noktalar arası da doldurulur; uzun
 * boşluklar — uçuş, sinyal kaybı — çizgiler zaten bölündüğü için atlanır). */
export function tilesOf(s: FileSummary): Set<number> {
  const hit = cache.get(s);
  if (hit) return hit;
  const out = new Set<number>();
  for (const line of s.lines) {
    for (let i = 0; i < line.length; i++) {
      const [lon, lat] = line[i];
      out.add(key(tx(lon), ty(lat)));
      if (i === 0) continue;
      const [lon0, lat0] = line[i - 1];
      // Karonun yarısından kısa adımlarla ara noktalar.
      const steps = Math.min(2000, Math.ceil(Math.max(Math.abs(lon - lon0), Math.abs(lat - lat0)) / (180 / N)));
      for (let k = 1; k < steps; k++) {
        const f = k / steps;
        out.add(key(tx(lon0 + (lon - lon0) * f), ty(lat0 + (lat - lat0) * f)));
      }
    }
  }
  cache.set(s, out);
  return out;
}

export interface ExplorerStats {
  tiles: Set<number>;
  /** Tümüyle keşfedilmiş en büyük kare (kenar uzunluğu, kare sayısı). */
  maxSquare: number;
  maxSquareAt: [number, number] | null;
}

export function explorerStats(files: FileSummary[]): ExplorerStats {
  const tiles = new Set<number>();
  for (const s of files) for (const t of tilesOf(s)) tiles.add(t);
  // En büyük dolu kare: (x, y) sağ alt köşe olan karenin kenarı.
  const sorted = [...tiles].sort((a, b) => a - b);
  const dp = new Map<number, number>();
  let maxSquare = 0;
  let maxSquareAt: [number, number] | null = null;
  // Sıralama x'e, sonra y'ye göre: sol ve üst komşular önce işlenir.
  for (const t of sorted) {
    const x = Math.floor(t / N);
    const y = t % N;
    const v = 1 + Math.min(dp.get(key(x - 1, y)) ?? 0, dp.get(key(x, y - 1)) ?? 0, dp.get(key(x - 1, y - 1)) ?? 0);
    dp.set(t, v);
    if (v > maxSquare) {
      maxSquare = v;
      maxSquareAt = [x, y];
    }
  }
  return { tiles, maxSquare, maxSquareAt };
}

const tilePoly = (x0: number, y0: number, x1: number, y1: number): GeoJSON.Polygon => ({
  type: "Polygon",
  coordinates: [
    [
      [lonOf(x0), latOf(y0)],
      [lonOf(x1), latOf(y0)],
      [lonOf(x1), latOf(y1)],
      [lonOf(x0), latOf(y1)],
      [lonOf(x0), latOf(y0)],
    ],
  ],
});

/** Haritada keşfedilen kareler ve en büyük kare. */
export function explorerGeoJSON(st: ExplorerStats): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [...st.tiles].map((t) => {
    const x = Math.floor(t / N);
    const y = t % N;
    return { type: "Feature", properties: { kind: "tile" }, geometry: tilePoly(x, y, x + 1, y + 1) };
  });
  if (st.maxSquareAt && st.maxSquare > 1) {
    const [x, y] = st.maxSquareAt;
    const k = st.maxSquare;
    features.push({ type: "Feature", properties: { kind: "square" }, geometry: tilePoly(x - k + 1, y - k + 1, x + 1, y + 1) });
  }
  return { type: "FeatureCollection", features };
}
