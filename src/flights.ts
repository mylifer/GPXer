/**
 * Uçuşlar: kayıt boşluklarından (gaps) türetilir. Ortalama hızı 300 km/sa'i ve
 * mesafesi 100 km'yi aşan ya da 6 saatten kısa sürede 200 km'den uzağa giden
 * boşluklar uçuş sayılır.
 */

import type { FileSummary, Gap } from "./api";
import { namedPlaceAt } from "./places";
import { gapEndsPlaces } from "./visits";

const MIN_SPEED_MS = 300 / 3.6;
const MIN_M = 100_000;
const FAR_M = 200_000;
const FAR_MAX_MS = 6 * 3_600_000;

export interface Flight {
  /** Kaydın yolu ve boşluğun sırası: kimlik. */
  path: string;
  gap: number;
  from: [number, number];
  to: [number, number];
  start: number;
  end: number;
  distanceM: number;
  durationMs: number;
  fromName: string | null;
  toName: string | null;
}

export function isFlight(g: Gap): g is Gap & { start: number; end: number } {
  if (g.start == null || g.end == null) return false;
  const dt = g.end - g.start;
  if (dt <= 0) return g.distanceM > MIN_M;
  return (g.distanceM > MIN_M && g.distanceM / (dt / 1000) > MIN_SPEED_MS) || (g.distanceM > FAR_M && dt < FAR_MAX_MS);
}

const cache = new WeakMap<FileSummary, Flight[]>();

/** Kaydın uçuşları (yer adları adlandırılmış yer ve yer dökümü dikkate alınmadan;
 * adlar için `flightLabel`). */
export function flightsOf(s: FileSummary): Flight[] {
  const hit = cache.get(s);
  if (hit) return hit;
  const out: Flight[] = [];
  (s.gaps ?? []).forEach((g, i) => {
    if (!isFlight(g)) return;
    const [fromName, toName] = gapEndsPlaces(s, g.start, g.end);
    out.push({
      path: s.path,
      gap: i,
      from: g.from,
      to: g.to,
      start: g.start,
      end: g.end,
      distanceM: g.distanceM,
      durationMs: g.end - g.start,
      fromName,
      toName,
    });
  });
  cache.set(s, out);
  return out;
}

const coord = (p: [number, number]) =>
  `${Math.abs(p[1]).toFixed(2)}°${p[1] >= 0 ? "K" : "G"} ${Math.abs(p[0]).toFixed(2)}°${p[0] >= 0 ? "D" : "B"}`;

/** Uçuşun bir ucunun adı: adlandırılmış yer, yer dökümü, yoksa koordinat. */
export function endName(f: Flight, which: "from" | "to"): string {
  const p = f[which];
  return namedPlaceAt(p[0], p[1])?.name ?? (which === "from" ? f.fromName : f.toName) ?? coord(p);
}

/** İki nokta arasında büyük daire yayı (küresel ara değer). Boylam, tarih
 * çizgisini aşan uçuşlarda kesintisiz kalsın diye açılır (180'i geçebilir). */
export function greatCircle(a: [number, number], b: [number, number], n = 48): [number, number][] {
  const rad = Math.PI / 180;
  const toV = ([lon, lat]: [number, number]) => [
    Math.cos(lat * rad) * Math.cos(lon * rad),
    Math.cos(lat * rad) * Math.sin(lon * rad),
    Math.sin(lat * rad),
  ];
  const va = toV(a);
  const vb = toV(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const w = Math.acos(dot);
  if (w < 1e-6) return [a, b];
  const sw = Math.sin(w);
  const out: [number, number][] = [];
  let prevLon = a[0];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const ka = Math.sin((1 - t) * w) / sw;
    const kb = Math.sin(t * w) / sw;
    const x = ka * va[0] + kb * vb[0];
    const y = ka * va[1] + kb * vb[1];
    const z = ka * va[2] + kb * vb[2];
    let lon = Math.atan2(y, x) / rad;
    const lat = Math.atan2(z, Math.hypot(x, y)) / rad;
    while (lon - prevLon > 180) lon -= 360;
    while (lon - prevLon < -180) lon += 360;
    prevLon = lon;
    out.push([lon, lat]);
  }
  return out;
}
