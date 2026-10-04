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
    // Bölgenin kenarı ekrana izdüşürülüp çokgen olarak örtülür: harita eğikken
    // (3B arazi) daire elipse dönüşür; yalnız kuzeye bakan yarıçap yetmez.
    const [lon, lat] = z.center;
    const dLat = (z.radiusM * 1.1) / 110_574;
    const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
    const edge = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      return project([lon + dLon * Math.sin(a), lat + dLat * Math.cos(a)]);
    });
    const c = project(z.center);
    ctx.save();
    ctx.beginPath();
    edge.forEach((p, i) => (i ? ctx.lineTo(p.x * scale, p.y * scale) : ctx.moveTo(p.x * scale, p.y * scale)));
    ctx.closePath();
    // Çok uzaktan bakılınca da görünür kalsın.
    ctx.moveTo((c.x + 6) * scale, c.y * scale);
    ctx.arc(c.x * scale, c.y * scale, 6 * scale, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(190,190,190,0.96)";
    ctx.fill("nonzero");
    ctx.restore();
  }
}
