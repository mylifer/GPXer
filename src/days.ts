/**
 * Günlere göre kayıt: birden çok güne (aylarca) yayılan kayıtların mesafesi
 * ve hareket süresi gerçekten kaydedildikleri günlere dağıtılır. Kaynak, özetteki
 * saatlik dökümdür (`hours`); yoksa (eski önbellek) kaydın tamamı başladığı güne
 * yazılır. Sonuçlar özet nesnesi ve saat dilimi kipine göre önbelleğe alınır.
 */

import type { FileSummary } from "./api";
import { dayKey, fastDayKey, tzOf } from "./format";

interface DayBucket {
  /** yyyy-aa-gg (Ayarlar'daki saat dilimi kipine göre) */
  day: string;
  distanceM: number;
  movingMs: number;
}

const tzKey = (s: FileSummary) => tzOf(s) ?? "";

const HOUR = 3_600_000;
const QUARTER = 900_000;

/** UTC saat diliminin ([h, h+1sa), kayıt başlangıcından önceki kısmı hariç)
 * düştüğü yerel günler ve payları (dakika oranında). Tam saat farklı dilimlerde
 * tek gün; :30/:45 farklı dilimlerde yerel gece yarısını aşan saat iki güne bölünür. */
export function hourDays(h: number, start: number | null | undefined, zone: string | undefined): [string, number][] {
  const a = start != null ? Math.max(h, Math.min(start, h + HOUR - 1)) : h;
  const end = h + HOUR;
  const k0 = fastDayKey(a, zone);
  const k1 = fastDayKey(end - 1, zone);
  if (k0 === k1) return [[k0, 1]];
  // Gün sınırı çeyrek saatlerden birinde: ilk farklı çeyreği bul.
  let b = Math.floor(a / QUARTER) * QUARTER + QUARTER;
  while (b < end && fastDayKey(b, zone) === k0) b += QUARTER;
  const f = (b - a) / (end - a);
  return [
    [k0, f],
    [k1, 1 - f],
  ];
}

const bucketCache = new WeakMap<FileSummary, { tz: string; days: DayBucket[] }>();

/** Kaydın gün gün dökümü (sıralı). Tarihsiz kayıtta boş. */
export function dayBuckets(s: FileSummary): DayBucket[] {
  const tz = tzKey(s);
  const hit = bucketCache.get(s);
  if (hit && hit.tz === tz) return hit.days;
  const zone = tzOf(s);
  const hours = Array.isArray(s.hours) ? s.hours : [];
  const start = s.stats.startTime;
  let days: DayBucket[];
  if (hours.length === 0) {
    days = start == null ? [] : [{ day: dayKey(start, zone), distanceM: s.stats.distanceM, movingMs: s.stats.movingMs ?? 0 }];
  } else {
    const map = new Map<string, DayBucket>();
    for (const [h, dist, moving] of hours) {
      // İlk saat dilimi kaydın başlangıcından önce başlayabilir.
      for (const [k, f] of hourDays(h, start, zone)) {
        const b = map.get(k);
        if (b) {
          b.distanceM += dist * f;
          b.movingMs += moving * f;
        } else map.set(k, { day: k, distanceM: dist * f, movingMs: moving * f });
      }
    }
    days = [...map.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  }
  bucketCache.set(s, { tz, days });
  return days;
}

/** Gün yyyy-aa-gg aralıkta mı ("" = sınırsız). */
export const dayIn = (day: string, from: string, to: string) => (!from || day >= from) && (!to || day <= to);

/** Kaydın herhangi bir günü aralığa düşüyor mu? */
export function touchesRange(s: FileSummary, from: string, to: string): boolean {
  const days = dayBuckets(s);
  if (days.length === 0) return false;
  // Sıralı: ilk ve son gün aralığın dışında kalıyorsa ve aralık arada değilse düşmez.
  if (from && days[days.length - 1].day < from) return false;
  if (to && days[0].day > to) return false;
  return days.some((d) => dayIn(d.day, from, to));
}

interface RangePart {
  distanceM: number;
  movingMs: number;
  days: number;
}

/** Kaydın aralığa düşen günlerinin toplamı. */
export function rangePart(s: FileSummary, from: string, to: string): RangePart {
  let distanceM = 0,
    movingMs = 0,
    days = 0;
  for (const d of dayBuckets(s)) {
    if (!dayIn(d.day, from, to)) continue;
    distanceM += d.distanceM;
    movingMs += d.movingMs;
    days++;
  }
  return { distanceM, movingMs, days };
}

/** Kaydın tamamı aralığın içinde mi (kırpmaya gerek yok). */
function fullyInRange(s: FileSummary, from: string, to: string): boolean {
  const days = dayBuckets(s);
  if (days.length === 0) return true;
  return dayIn(days[0].day, from, to) && dayIn(days[days.length - 1].day, from, to);
}

interface ClippedGeometry {
  lines: [number, number][][];
  gaps: FileSummary["gaps"];
  bbox: [number, number, number, number] | null;
}

const clipCache = new WeakMap<FileSummary, { key: string; geo: ClippedGeometry }>();

/** Haritada çizilecek kısım: zamanı aralık dışındaki noktalar atılır (zamansız
 * noktalar kalır), çizgi aralık sınırlarında bölünür. Boşluklar da her iki ucu
 * aralıkta kalıyorsa çizilir. */
export function clipToRange(s: FileSummary, from: string, to: string): ClippedGeometry {
  const whole: ClippedGeometry = { lines: s.lines, gaps: s.gaps ?? [], bbox: s.stats.bbox };
  if ((!from && !to) || fullyInRange(s, from, to)) return whole;
  const key = `${tzKey(s)}|${from}|${to}`;
  const hit = clipCache.get(s);
  if (hit && hit.key === key) return hit.geo;
  const zone = tzOf(s);
  const inT = (t: number | null | undefined) => t == null || dayIn(fastDayKey(t, zone), from, to);
  const lines: [number, number][][] = [];
  let bb = null as [number, number, number, number] | null;
  for (let li = 0; li < s.lines.length; li++) {
    const line = s.lines[li];
    const times = s.times[li];
    let cur: [number, number][] = [];
    for (let i = 0; i < line.length; i++) {
      if (inT(times?.[i])) {
        const p = line[i];
        cur.push(p);
        if (!bb) bb = [p[0], p[1], p[0], p[1]];
        else {
          if (p[0] < bb[0]) bb[0] = p[0];
          if (p[1] < bb[1]) bb[1] = p[1];
          if (p[0] > bb[2]) bb[2] = p[0];
          if (p[1] > bb[3]) bb[3] = p[1];
        }
      } else if (cur.length) {
        if (cur.length > 1) lines.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) lines.push(cur);
  }
  const gaps = (s.gaps ?? []).filter((g) => inT(g.start) && inT(g.end));
  const geo: ClippedGeometry = { lines, gaps, bbox: bb };
  clipCache.set(s, { key, geo });
  return geo;
}

interface DetailDay {
  day: string;
  /** Ayrıntı örneklerinde ilk ve son sıra. */
  start: number;
  end: number;
  distanceM: number;
}

const detailDayCache = new WeakMap<object, { key: string; days: DetailDay[] }>();

/** Ayrıntı (grafik) örneklerinin gün gün sıra aralıkları; mesafe özetin günlük
 * dökümünden (boşluklar hariç), yoksa örneklerden. */
export function detailDays(
  s: FileSummary,
  d: { time: (number | null)[]; dist: number[] },
): DetailDay[] {
  const key = `${tzKey(s)}|${s.path}`;
  const hit = detailDayCache.get(d);
  if (hit && hit.key === key) return hit.days;
  const zone = tzOf(s);
  const byDay = new Map<string, DetailDay>();
  for (let i = 0; i < d.time.length; i++) {
    const t = d.time[i];
    if (t == null) continue;
    const k = fastDayKey(t, zone);
    const x = byDay.get(k);
    if (x) {
      if (i < x.start) x.start = i;
      if (i > x.end) x.end = i;
    } else byDay.set(k, { day: k, start: i, end: i, distanceM: 0 });
  }
  const dist = new Map(dayBuckets(s).map((b) => [b.day, b.distanceM]));
  const days = [...byDay.values()].sort((a, b) => a.start - b.start);
  // Gün, ertesi günün ilk örneğine kadar sürer: gece yarısını aşan adım
  // (saatlik dökümde olduğu gibi) başladığı güne sayılır; yoksa seçili günün
  // aralık istatistiği gün seçicideki mesafeden kısa çıkıyordu.
  for (let k = 0; k + 1 < days.length; k++) {
    if (days[k + 1].start === days[k].end + 1) days[k].end = days[k + 1].start;
  }
  for (const x of days) x.distanceM = dist.get(x.day) ?? d.dist[x.end] - d.dist[x.start];
  detailDayCache.set(d, { key, days });
  return days;
}

interface Share {
  distanceM: number;
  movingMs: number;
  /** Tırmanışın günlük dökümü yok: mesafe oranında paylaştırılır. */
  gainM: number;
  /** Kaydın yalnızca bir kısmı aralıkta. */
  partial: boolean;
}

/** Tarih filtresi açıkken kaydın toplamlara katılan payı; filtre yoksa ya da
 * kaydın tamamı aralıktaysa kaydın kendi değerleri. */
export function rangeShare(s: FileSummary, from: string, to: string): Share {
  const st = s.stats;
  if ((!from && !to) || st.startTime == null || fullyInRange(s, from, to))
    return { distanceM: st.distanceM, movingMs: st.movingMs ?? 0, gainM: st.elevationGainM ?? 0, partial: false };
  const r = rangePart(s, from, to);
  const frac = st.distanceM > 0 ? r.distanceM / st.distanceM : 0;
  return { distanceM: r.distanceM, movingMs: r.movingMs, gainM: (st.elevationGainM ?? 0) * frac, partial: true };
}

export interface DayTotal {
  distanceM: number;
  movingMs: number;
  /** Tırmanışın günlük dökümü yok: kaydın mesafesi oranında. */
  gainM: number;
}

const dedupCache = new WeakMap<FileSummary[], { tz: string; days: Map<string, DayTotal> }>();

/** Kayıtların gün gün toplamı, kopyalar bir kez sayılarak: aynı saatte
 * birden çok kaydın verisi varsa (aynı yolculuğun kopyaları, konum geçmişi
 * ile o günün kaydı) o saat için en çok mesafeli kayıt sayılır. Aynı gün
 * farklı saatlerdeki ayrı etkinlikler etkilenmez. Saatlik dökümü olmayan
 * (zamansız ya da eski önbellek) kayıtlar başladıkları güne olduğu gibi yazılır. */
export function dedupedDays(files: FileSummary[]): Map<string, DayTotal> {
  const tz = files.map(tzKey).join("|");
  const hit = dedupCache.get(files);
  if (hit && hit.tz === tz) return hit.days;
  const best = new Map<number, { d: number; m: number; s: FileSummary }>();
  const days = new Map<string, DayTotal>();
  const add = (day: string, d: number, m: number, g: number) => {
    const x = days.get(day);
    if (x) {
      x.distanceM += d;
      x.movingMs += m;
      x.gainM += g;
    } else days.set(day, { distanceM: d, movingMs: m, gainM: g });
  };
  for (const s of files) {
    const hours = Array.isArray(s.hours) ? s.hours : [];
    if (hours.length === 0) {
      if (s.stats.startTime != null)
        add(dayKey(s.stats.startTime, tzOf(s)), s.stats.distanceM, s.stats.movingMs ?? 0, s.stats.elevationGainM ?? 0);
      continue;
    }
    for (const [h, d, m] of hours) {
      const cur = best.get(h);
      if (!cur || d > cur.d || (d === cur.d && m > cur.m)) best.set(h, { d, m, s });
    }
  }
  for (const [h, { d, m, s }] of best) {
    const total = s.stats.distanceM;
    const g = total > 0 ? ((s.stats.elevationGainM ?? 0) * d) / total : 0;
    for (const [k, f] of hourDays(h, s.stats.startTime, tzOf(s))) add(k, d * f, m * f, g * f);
  }
  dedupCache.set(files, { tz, days });
  return days;
}

/** [`dedupedDays`] toplamı, tarih aralığında. */
export function dedupedTotals(files: FileSummary[], from: string, to: string): DayTotal & { days: number } {
  const out = { distanceM: 0, movingMs: 0, gainM: 0, days: 0 };
  for (const [day, t] of dedupedDays(files)) {
    if (!dayIn(day, from, to)) continue;
    out.distanceM += t.distanceM;
    out.movingMs += t.movingMs;
    out.gainM += t.gainM;
    if (t.distanceM > 0 || t.movingMs > 0) out.days++;
  }
  return out;
}
