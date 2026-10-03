/**
 * Uçuşlar: kayıt boşluklarından (gaps) türetilir. Ortalama hızı 300 km/sa'i ve
 * mesafesi 100 km'yi aşan ya da 6 saatten kısa sürede 200 km'den uzağa giden
 * boşluklar uçuş sayılır; her durumda ortalama hız en az 150 km/sa olmalıdır
 * (kayıt boşluğu olan araba yolculukları uçuş sayılmasın).
 */

import type { FileSummary, Gap } from "./api";
import { namedPlaceAt } from "./places";
import { metersBetween } from "./geo";
import { gapEndsPlaces } from "./visits";

const MIN_SPEED_MS = 300 / 3.6;
const MIN_M = 100_000;
const FAR_M = 200_000;
const FAR_MAX_MS = 6 * 3_600_000;
/** Tüm kurallar için en düşük ortalama hız. */
const FLOOR_SPEED_MS = 150 / 3.6;
/** Yolcu uçağı bundan hızlı gitmez (kuyruk rüzgârıyla bile): daha hızlı
 * "boşluk" GPS sıçraması ya da bozuk saattir, uçuş değil. */
const MAX_SPEED_MS = 1200 / 3.6;

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

function isFlight(g: Gap): g is Gap & { start: number; end: number } {
  if (g.start == null || g.end == null) return false;
  const dt = g.end - g.start;
  // Süresiz ya da geriye giden boşluk: saat hatası, uçuş değil.
  if (dt <= 0) return false;
  const speed = g.distanceM / (dt / 1000);
  if (g.distanceM <= MIN_M || speed < FLOOR_SPEED_MS || speed > MAX_SPEED_MS) return false;
  return speed > MIN_SPEED_MS || (g.distanceM > FAR_M && dt < FAR_MAX_MS);
}

const cache = new WeakMap<FileSummary, Flight[]>();

/** Kaydın uçuşları (yer adları adlandırılmış yer ve yer dökümü dikkate alınmadan;
 * adlar için `flightLabel`). */
export function flightsOf(s: FileSummary): Flight[] {
  const hit = cache.get(s);
  if (hit) return hit;
  const out: Flight[] = [];
  const gaps = s.gaps ?? [];
  for (let i = 0; i < gaps.length; i++) {
    const g = gaps[i];
    if (!isFlight(g)) continue;
    // Uçarken alınan bir iki nokta uçuşu ikiye böler (ör. inişte): hemen
    // ardından gelen hızlı boşluklar aynı uçuşa katılır.
    let last = g;
    let distanceM = g.distanceM;
    while (i + 1 < gaps.length && continuesFlight(last, gaps[i + 1])) {
      const next = gaps[i + 1] as Gap & { start: number; end: number };
      distanceM += metersBetween(last.to, next.from) + next.distanceM;
      last = next;
      i++;
    }
    // Ad önce saatlik yer dökümünden (uçuş hızındaki noktalar orada yok:
    // kalkıştan önceki ve inişten sonraki yer); yoksa boşluk uçlarının adı.
    const [visitFrom, visitTo] = gapEndsPlaces(s, g.start, last.end);
    const fromName = visitFrom ?? g.fromPlace ?? null;
    const toName = visitTo ?? last.toPlace ?? null;
    out.push({
      path: s.path,
      gap: gaps.indexOf(g),
      from: g.from,
      to: last.to,
      start: g.start,
      end: last.end,
      distanceM,
      durationMs: last.end - g.start,
      fromName,
      toName,
    });
  }
  cache.set(s, out);
  return out;
}

/** Uçuşun hemen ardından (30 dakika içinde) gelen ve ortalaması uçuş hızında
 * olan boşluk aynı uçuşun devamıdır. */
const CONTINUE_MS = 30 * 60_000;
function continuesFlight(prev: Gap & { end: number }, next: Gap): boolean {
  if (next.start == null || next.end == null || next.end <= next.start) return false;
  if (next.start - prev.end > CONTINUE_MS) return false;
  // Aradaki noktalar da uçuş hızında olmalı (yerde bekleme değil).
  const between = metersBetween(prev.to, next.from) / Math.max(1, (next.start - prev.end) / 1000);
  const speed = next.distanceM / ((next.end - next.start) / 1000);
  if (speed > MAX_SPEED_MS) return false;
  return speed >= FLOOR_SPEED_MS && (between >= FLOOR_SPEED_MS || next.start - prev.end < 60_000);
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
