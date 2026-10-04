/** Özet penceresi için saf hesaplar: gezilen yerler ve adlandırılmış yerlerde geçen süre. */
import type { NamedPlace } from "./api";
import type { FileEntry } from "./types";
import { fastDayKey, tzOf } from "./format";
import { dayIn, hourDays } from "./days";
import { namedPlaceAt } from "./places";
import { hourPlaces } from "./visits";

interface YearVisits {
  year: string;
  countries: { cc: string; days: number }[];
  cities: { cc: string; name: string; days: number }[];
}

/** Ülke ve şehirlerde geçen günler (yer dökümü olan saatlerden). */
export function visitedPlaces(files: FileEntry[], from: string, to: string) {
  const years = new Map<string, { countries: Map<string, Set<string>>; cities: Map<string, Set<string>> }>();
  const first = new Map<string, string>();
  const allDays = new Map<string, Set<string>>();
  for (const f of files) {
    const s = f.summary;
    const hp = hourPlaces(s);
    if (!hp.length) continue;
    const zone = tzOf(s);
    const start = s.stats.startTime;
    for (const x of hp) {
      if (!x.cc && !x.name) continue;
      // :30/:45 farklı dilimlerde gece yarısını aşan saat iki güne de sayılır.
      for (const [day] of hourDays(x.h, start, zone)) {
        if (!dayIn(day, from, to)) continue;
        const y = day.slice(0, 4);
        let yv = years.get(y);
        if (!yv) years.set(y, (yv = { countries: new Map(), cities: new Map() }));
        const cc = x.cc.toUpperCase();
        if (cc) {
          let cs = yv.countries.get(cc);
          if (!cs) yv.countries.set(cc, (cs = new Set()));
          cs.add(day);
          let all = allDays.get(cc);
          if (!all) allDays.set(cc, (all = new Set()));
          all.add(day);
          const fd = first.get(cc);
          if (!fd || day < fd) first.set(cc, day);
        }
        if (x.name) {
          const k = `${cc}|${x.name}`;
          let ci = yv.cities.get(k);
          if (!ci) yv.cities.set(k, (ci = new Set()));
          ci.add(day);
        }
      }
    }
  }
  const out: YearVisits[] = [...years.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([year, v]) => ({
      year,
      countries: [...v.countries.entries()].map(([cc, d]) => ({ cc, days: d.size })).sort((a, b) => b.days - a.days),
      cities: [...v.cities.entries()]
        .map(([k, d]) => {
          const i = k.indexOf("|");
          return { cc: k.slice(0, i), name: k.slice(i + 1), days: d.size };
        })
        .sort((a, b) => b.days - a.days),
    }));
  const firsts = [...first.entries()]
    .map(([cc, day]) => ({ cc, day, days: allDays.get(cc)?.size ?? 0 }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { years: out, firsts };
}

/** Adlandırılmış yerlerde ay ay geçen süre (duraklamalardan). */
export function timeAtPlaces(files: FileEntry[], places: NamedPlace[], from: string, to: string) {
  const months = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  if (!places.length) return { months: [] as { key: string; by: Map<string, number> }[], totals };
  for (const f of files) {
    const zone = tzOf(f.summary);
    for (const st of f.summary.stops) {
      const p = namedPlaceAt(st.lon, st.lat, places);
      if (!p) continue;
      const day = fastDayKey(st.start, zone);
      if (!dayIn(day, from, to)) continue;
      const m = day.slice(0, 7);
      let by = months.get(m);
      if (!by) months.set(m, (by = new Map()));
      by.set(p.id, (by.get(p.id) ?? 0) + st.durationMs);
      totals.set(p.id, (totals.get(p.id) ?? 0) + st.durationMs);
    }
  }
  return {
    months: [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, by]) => ({ key, by })),
    totals,
  };
}

export interface PlaceStat {
  name: string;
  /** Ülke kodu (şehirlerde). */
  cc?: string;
  /** Kaç ayrı günde bulunuldu. */
  days: number;
  /** Ziyaret sayısı (adlandırılmış yerlerde duraklama sayısı, şehirlerde ayrı gün dizileri). */
  visits: number;
  /** Toplam süre (yalnızca adlandırılmış yerlerde, duraklamalardan). */
  ms?: number;
  first: string;
  last: string;
}

/** Yer bazlı istatistik: adlandırılmış yerler (duraklamalardan) ve şehirler
 * (saat saat yer dökümünden), tüm yıllar boyunca. */
export function placeStats(files: FileEntry[], places: NamedPlace[], from: string, to: string) {
  const named = new Map<string, { days: Set<string>; visits: number; ms: number }>();
  for (const f of files) {
    const zone = tzOf(f.summary);
    for (const st of f.summary.stops) {
      const p = places.length ? namedPlaceAt(st.lon, st.lat, places) : null;
      if (!p) continue;
      const day = fastDayKey(st.start, zone);
      if (!dayIn(day, from, to)) continue;
      const v = named.get(p.id) ?? { days: new Set<string>(), visits: 0, ms: 0 };
      v.days.add(day);
      v.visits++;
      v.ms += st.durationMs;
      named.set(p.id, v);
    }
  }
  const cities = new Map<string, { cc: string; name: string; days: Set<string> }>();
  for (const f of files) {
    const s = f.summary;
    const zone = tzOf(s);
    for (const x of hourPlaces(s)) {
      if (!x.name) continue;
      for (const [day] of hourDays(x.h, s.stats.startTime, zone)) {
        if (!dayIn(day, from, to)) continue;
        const k = `${x.cc}|${x.name}`;
        const c = cities.get(k) ?? { cc: x.cc.toUpperCase(), name: x.name, days: new Set<string>() };
        c.days.add(day);
        cities.set(k, c);
      }
    }
  }
  const span = (days: Set<string>) => {
    const d = [...days].sort();
    return { first: d[0] ?? "", last: d[d.length - 1] ?? "" };
  };
  // Ardışık günler tek ziyaret sayılır.
  const runs = (days: Set<string>) => {
    const d = [...days].sort();
    let n = 0;
    let prev = 0;
    for (const x of d) {
      const t = Date.parse(`${x}T00:00:00Z`);
      if (!n || t - prev > 86_400_000) n++;
      prev = t;
    }
    return n;
  };
  return {
    named: places
      .filter((p) => named.has(p.id))
      .map((p): PlaceStat => {
        const v = named.get(p.id)!;
        return { name: p.name, days: v.days.size, visits: v.visits, ms: v.ms, ...span(v.days) };
      })
      .sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)),
    cities: [...cities.values()]
      .map((c): PlaceStat => ({ name: c.name, cc: c.cc, days: c.days.size, visits: runs(c.days), ...span(c.days) }))
      .sort((a, b) => b.days - a.days),
  };
}
