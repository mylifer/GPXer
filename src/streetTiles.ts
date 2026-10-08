/** Sokak dizini için indirilecek z14 karoları (bir alan ya da il sınırı). */
import { inPolygon } from "./regions";

export const STREET_ZOOM = 14;
/** Bir z14 vektör karosunun ortalama boyutu (KB); tahmin için. */
export const TILE_KB = 60;
/** Bir seferde en çok bu kadar karo (sunucuya yük olmasın, iş saatlerce sürmesin). */
export const MAX_TILES = 20_000;

const n = 2 ** STREET_ZOOM;
const tileX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
const tileY = (lat: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
};
const lonOf = (x: number) => (x / n) * 360 - 180;
const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** Kutuya [batı, güney, doğu, kuzey] değen karolar. */
export function tilesInBox([w, s, e, nn]: [number, number, number, number]): [number, number][] {
  const out: [number, number][] = [];
  for (let x = tileX(w); x <= tileX(e); x++) for (let y = tileY(nn); y <= tileY(s); y++) out.push([x, y]);
  return out;
}

/** Çokgene değen karolar: karonun ortası ya da köşelerinden biri içerideyse
 * ya da çokgenin bir köşesi karonun içindeyse (küçük adalar, ince kıyılar). */
export function tilesInPolygon(polys: number[][][][]): [number, number][] {
  let [w, s, e, nn] = [Infinity, Infinity, -Infinity, -Infinity];
  const corners = new Set<string>();
  for (const p of polys)
    for (const [x, y] of p[0]) {
      w = Math.min(w, x);
      e = Math.max(e, x);
      s = Math.min(s, y);
      nn = Math.max(nn, y);
      corners.add(`${tileX(x)},${tileY(y)}`);
    }
  return tilesInBox([w, s, e, nn]).filter(([x, y]) => {
    if (corners.has(`${x},${y}`)) return true;
    const [x0, x1, y0, y1] = [lonOf(x), lonOf(x + 1), latOf(y + 1), latOf(y)];
    return [
      [(x0 + x1) / 2, (y0 + y1) / 2],
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].some(([lo, la]) => inPolygon(lo, la, polys));
  });
}
