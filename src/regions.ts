import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FileSummary } from "./api";
import { dayIn } from "./days";
import { dayKey, tzOf } from "./format";
import provincesUrl from "./assets/geo/tr-iller.geojson?url";
import countriesUrl from "./assets/geo/ulkeler.geojson?url";

/** Bir bölge (il) ve sınır kutusu: nokta testinden önce hızlı eleme. */
interface Region {
  name: string;
  bbox: [number, number, number, number];
  polys: number[][][][];
}

export type ProvinceFC = FeatureCollection<MultiPolygon, { name: string }>;
export type CountryFC = FeatureCollection<MultiPolygon, { cc: string }>;

export const PROVINCE_COUNT = 81;

let provincesP: Promise<ProvinceFC> | null = null;
let countriesP: Promise<CountryFC> | null = null;
/** Türkiye il sınırları (uygulamaya gömülü; ilk istekte yüklenir). */
export function loadProvinces(): Promise<ProvinceFC> {
  provincesP ??= fetch(provincesUrl).then((r) => r.json());
  return provincesP;
}
/** Dünya ülke sınırları (`cc`: ISO alfa-2). */
export function loadCountries(): Promise<CountryFC> {
  countriesP ??= fetch(countriesUrl).then((r) => r.json());
  return countriesP;
}

const regionCache = new WeakMap<ProvinceFC, Region[]>();
function regionsOf(fc: ProvinceFC): Region[] {
  let r = regionCache.get(fc);
  if (!r) {
    r = fc.features.map((f) => {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of f.geometry.coordinates)
        for (const [x, y] of p[0]) {
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      return { name: f.properties.name, bbox: [x0, y0, x1, y1], polys: f.geometry.coordinates };
    });
    regionCache.set(fc, r);
  }
  return r;
}

/** Işın atma: halka içinde mi. */
function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Noktanın bulunduğu bölge (delikler hesaba katılır). */
export function regionAt(lon: number, lat: number, regions: Region[], hint?: Region | null): Region | null {
  const test = (r: Region) => {
    const [x0, y0, x1, y1] = r.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
    return r.polys.some((p) => inRing(lon, lat, p[0]) && !p.slice(1).some((h) => inRing(lon, lat, h)));
  };
  // Ardışık noktalar çoğunlukla aynı ildedir: önce bir öncekine bakılır.
  if (hint && test(hint)) return hint;
  return regions.find(test) ?? null;
}

/** Kaydın geçtiği iller ve her birine ilk girildiği an. Noktalar ~1 km
 * seyreltilerek denenir (sınırdaki birkaç yüz metre ihmal edilir). */
const visitCache = new WeakMap<FileSummary, { fc: ProvinceFC; v: Map<string, number | null> }>();
export function provincesOf(s: FileSummary, fc: ProvinceFC): Map<string, number | null> {
  const hit = visitCache.get(s);
  if (hit && hit.fc === fc) return hit.v;
  const regions = regionsOf(fc);
  const out = new Map<string, number | null>();
  // Türkiye'nin kabaca sınır kutusu: dışındaki kayıtlarda hiç deneme yapılmaz.
  const inTr = (lon: number, lat: number) => lon > 25.5 && lon < 45 && lat > 35.7 && lat < 42.2;
  let hint: Region | null = null;
  s.lines.forEach((line, i) => {
    const times = s.times[i];
    let last: [number, number] | null = null;
    line.forEach(([lon, lat], j) => {
      if (!inTr(lon, lat)) return;
      if (last && Math.abs(lon - last[0]) < 0.01 && Math.abs(lat - last[1]) < 0.008 && j < line.length - 1) return;
      last = [lon, lat];
      const r = regionAt(lon, lat, regions, hint);
      if (!r) return;
      hint = r;
      const t = times?.[j] ?? s.stats.startTime;
      const prev = out.get(r.name);
      if (prev === undefined || (t != null && (prev == null || t < prev))) out.set(r.name, t ?? null);
    });
  });
  visitCache.set(s, { fc, v: out });
  return out;
}

export interface ProvinceVisit {
  name: string;
  /** İlk girilen gün (YYYY-AA-GG); zamansız kayıtlarda boş. */
  first: string;
  /** Kaç kayıtta geçildi. */
  records: number;
  /** İlk giriş anı (sıralama için). */
  at: number | null;
}

/** Gösterilen kayıtlarda geçilen iller (tarih filtresine göre: ilk giriş o
 * aralıkta olmasa da aralıkta geçilen il sayılır). */
export function visitedProvinces(files: FileSummary[], fc: ProvinceFC, from: string, to: string): ProvinceVisit[] {
  const m = new Map<string, ProvinceVisit>();
  for (const s of files) {
    const zone = tzOf(s);
    for (const [name, t] of provincesOf(s, fc)) {
      const day = t != null ? dayKey(t, zone) : "";
      if ((from || to) && day && !dayIn(day, from, to)) continue;
      const v = m.get(name);
      if (!v) m.set(name, { name, first: day, records: 1, at: t });
      else {
        v.records++;
        if (t != null && (v.at == null || t < v.at)) {
          v.at = t;
          v.first = day;
        }
      }
    }
  }
  return [...m.values()].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.name.localeCompare(b.name, "tr"));
}
