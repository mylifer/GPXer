import type { NamedPlace } from "./api";
import { metersBetween } from "./geo";

/** Gizlilik bölgeleri: `[boylam, enlem]` merkez ve yarıçap (en az 300 m). */
export interface Zone {
  center: [number, number];
  radiusM: number;
}

export const privacyZones = (places: NamedPlace[]): Zone[] =>
  places.filter((p) => p.private).map((p) => ({ center: [p.lon, p.lat], radiusM: Math.max(300, p.radiusM) }));

export const inZone = (p: [number, number], zones: Zone[]) => zones.some((z) => metersBetween(p, z.center) <= z.radiusM);

/** Çizgileri bölgelerde böler (bölgedeki noktalar atılır). */
export function maskLines(lines: [number, number][][], zones: Zone[]): [number, number][][] {
  if (!zones.length) return lines;
  const out: [number, number][][] = [];
  for (const line of lines) {
    let cur: [number, number][] = [];
    for (const p of line) {
      if (inZone(p, zones)) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push(p);
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

/** Harita görüntüsünde bölgeleri gri dairelerle örter (PNG, video, hikâye). */
export function maskCanvas(
  ctx: CanvasRenderingContext2D,
  project: (lonLat: [number, number]) => { x: number; y: number },
  zones: Zone[],
  scale: number,
) {
  for (const z of zones) {
    const c = project(z.center);
    // Yarıçap kuzeydeki bir noktanın ekrandaki uzaklığından.
    const north = project([z.center[0], z.center[1] + z.radiusM / 110_574]);
    const r = Math.hypot(north.x - c.x, north.y - c.y) * scale;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c.x * scale, c.y * scale, Math.max(r, 6 * scale), 0, Math.PI * 2);
    ctx.fillStyle = "rgba(190,190,190,0.96)";
    ctx.fill();
    ctx.restore();
  }
}
