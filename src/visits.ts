/**
 * Saat saat bulunulan yerler (özetteki `visits`): ülke/şehir dökümü, bir anda
 * neredeydim, uçuşların kalkış/varış adları.
 */

import type { FileSummary } from "./api";

const HOUR = 3_600_000;

export interface HourPlace {
  /** Saat başı (Unix ms, UTC). */
  h: number;
  cc: string;
  name: string;
}

const visitsOf = (s: FileSummary) => (Array.isArray(s.visits) ? s.visits : []);

/** `t` anını kapsayan öğenin sırası (visits saat başına göre sıralı); yoksa -1. */
function coverIdx(v: [number, string, string][], t: number): number {
  let a = 0;
  let b = v.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (v[m][0] <= t) a = m + 1;
    else b = m;
  }
  return a - 1;
}

/** `t` anında bulunulan yer (kaydın yer dökümünden). */
export function visitAt(s: FileSummary, t: number): { cc: string; name: string } | null {
  const v = visitsOf(s);
  if (!v.length) return null;
  const i = coverIdx(v, t);
  const x = v[Math.max(0, i)];
  // Kaydın ilk yer öğesinden çok önceki an: bilinmiyor.
  if (i < 0 && x[0] - t > HOUR) return null;
  return { cc: x[1], name: x[2] };
}

/** Bir boşluğun (uçuşun) iki ucundaki yer adları: kalkışta boşluktan önceki son
 * öğe, varışta boşluğun bittiği saati kapsayan (o da kalkışınkiyse sonraki) öğe. */
export function gapEndsPlaces(s: FileSummary, start: number, end: number): [string | null, string | null] {
  const v = visitsOf(s);
  if (!v.length) return [null, null];
  const i = coverIdx(v, start);
  let j = coverIdx(v, end);
  if (j === i && j + 1 < v.length && v[j + 1][0] - end < 6 * HOUR) j++;
  const name = (k: number) => (k >= 0 && k < v.length ? v[k][2] || null : null);
  return [name(i), j === i ? null : name(j)];
}

const hourCache = new WeakMap<FileSummary, HourPlace[]>();

/** Verisi olan her saat için bulunulan yer. Saatlik döküm (`hours`) varsa yalnızca
 * o saatler (kaydın durduğu araları saymamak için), yoksa yer öğelerinin kendisi. */
export function hourPlaces(s: FileSummary): HourPlace[] {
  const hit = hourCache.get(s);
  if (hit) return hit;
  const v = visitsOf(s);
  let out: HourPlace[] = [];
  if (v.length) {
    const hours = Array.isArray(s.hours) ? s.hours : [];
    if (hours.length) {
      let k = 0;
      for (const [h] of hours) {
        while (k + 1 < v.length && v[k + 1][0] <= h) k++;
        if (v[k][0] > h + HOUR) continue;
        out.push({ h, cc: v[k][1], name: v[k][2] });
      }
    } else out = v.map(([h, cc, name]) => ({ h, cc, name }));
  }
  hourCache.set(s, out);
  return out;
}

let regionNames: Intl.DisplayNames | null | undefined;

/** Ülke kodunun Türkçe adı ("DE" → "Almanya"). */
export function countryName(cc: string): string {
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["tr"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(cc.toUpperCase()) ?? cc;
  } catch {
    return cc;
  }
}

/** Ülke kodundan bayrak emojisi ("TR" → 🇹🇷). */
export function flagOf(cc: string): string {
  if (!/^[A-Za-z]{2}$/.test(cc)) return "🏳";
  const up = cc.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}
