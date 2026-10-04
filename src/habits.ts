import type { FileSummary } from "./api";
import { dayIn } from "./days";
import { dayKey, fastDayKey, tzOffsetMs, tzOf } from "./format";

const H = 3_600_000;

export interface Habits {
  /** Yerel saate göre 24 saatlik mesafe dağılımı (m). */
  byHour: number[];
  /** Haftanın günlerine göre (Pazartesi = 0) mesafe (m). */
  byWeekday: number[];
  /** Gece (20:00–06:00) gidilen mesafe payı. */
  nightShare: number;
  /** Saatlik ortalama hız (km/sa); verisi olmayan saatte null. */
  speedByHour: (number | null)[];
  /** En uzun molasız sürüş (15 dakikadan uzun duraklama ya da kesinti olmadan). */
  longest: { path: string; start: number; ms: number } | null;
  totalM: number;
}

/** Kayıtların saatlik dökümünden alışkanlıklar. Aynı saatte birden çok kayıt
 * (kopyalar) varsa en uzun mesafeli olanı sayılır. */
export function drivingHabits(files: FileSummary[], from: string, to: string): Habits {
  const hours = new Map<number, { m: number; ms: number; tz: string | null }>();
  for (const s of files) {
    for (const [h, m, ms] of Array.isArray(s.hours) ? s.hours : []) {
      const cur = hours.get(h);
      if (!cur || m > cur.m) hours.set(h, { m, ms, tz: s.timeZone });
    }
  }
  const byHour = new Array(24).fill(0);
  const msByHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  let night = 0;
  let total = 0;
  for (const [h, v] of hours) {
    if ((from || to) && !dayIn(fastDayKey(h, tzOf({ timeZone: v.tz })), from, to)) continue;
    // Alışkanlık kaydın yapıldığı yerin saatine göre (yurt dışında da doğru).
    const wall = new Date(h + tzOffsetMs(h, v.tz));
    const hr = wall.getUTCHours();
    byHour[hr] += v.m;
    msByHour[hr] += v.ms;
    byWeekday[(wall.getUTCDay() + 6) % 7] += v.m;
    if (hr >= 20 || hr < 6) night += v.m;
    total += v.m;
  }
  // En uzun molasız sürüş: kayıt içinde duraklamalar ve kesintiler arası.
  let longest: Habits["longest"] = null;
  for (const s of files) {
    const t0 = s.stats.startTime;
    const t1 = s.stats.endTime;
    if (t0 == null || t1 == null) continue;
    const breaks: [number, number][] = [
      ...(s.stops ?? []).filter((st) => st.durationMs >= 15 * 60_000).map((st) => [st.start, st.start + st.durationMs] as [number, number]),
      ...(s.gaps ?? []).flatMap((g) => (g.start != null && g.end != null && g.end - g.start >= 15 * 60_000 ? [[g.start, g.end] as [number, number]] : [])),
    ];
    // Seyrek kayıtlarda (konum geçmişi) noktalar arası uzun aralar da moladır.
    let prevT: number | null = null;
    for (const times of s.times ?? []) {
      for (const t of times ?? []) {
        if (t == null) continue;
        if (prevT != null && t - prevT >= 15 * 60_000) breaks.push([prevT, t]);
        prevT = t;
      }
    }
    breaks.sort((a, b) => a[0] - b[0]);
    // Hareket olan ardışık saatler (verisi olmayan saat de moladır), kayıt
    // sınırına ve molalara göre bölünür.
    const active = (Array.isArray(s.hours) ? s.hours : []).filter(([, , ms]) => ms >= 10 * 60_000).map(([h0]) => h0);
    active.sort((x, y) => x - y);
    const runs: [number, number][] = [];
    for (const h0 of active) {
      const last = runs[runs.length - 1];
      if (last && last[1] === h0) last[1] = h0 + H;
      else runs.push([h0, h0 + H]);
    }
    for (const [ra, rb] of runs) {
      let cur = Math.max(ra, t0);
      const end = Math.min(rb, t1);
      for (const [a, b] of [...breaks.filter(([x, y]) => y > cur && x < end), [end, end] as [number, number]]) {
        const stop = Math.min(a, end);
        const ms = stop - cur;
        if (ms > 0 && (!longest || ms > longest.ms) && (!(from || to) || dayIn(dayKey(cur, tzOf(s)), from, to)))
          longest = { path: s.path, start: cur, ms };
        cur = Math.max(cur, b);
        if (cur >= end) break;
      }
    }
  }
  return {
    byHour,
    byWeekday,
    nightShare: total > 0 ? night / total : 0,
    speedByHour: byHour.map((m, i) => (msByHour[i] > 10 * 60_000 ? m / 1000 / (msByHour[i] / H) : null)),
    longest,
    totalM: total,
  };
}
