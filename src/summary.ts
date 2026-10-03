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
