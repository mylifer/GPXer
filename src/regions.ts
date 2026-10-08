import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FileSummary } from "./api";
import { dayIn } from "./days";
import { fastDayKey, tzOf } from "./format";
import provincesUrl from "./assets/geo/tr-iller.geojson?url";
import countriesUrl from "./assets/geo/ulkeler.geojson?url";
import worldUrl from "./assets/geo/bolgeler.geojson?url";
import { lang } from "./i18n";

/** Bir bölge (il, eyalet…) ve sınır kutusu: nokta testinden önce hızlı eleme. */
interface Region {
  /** Ülke + ad: ülkeler arasında aynı adlı bölgeler karışmasın. */
  key: string;
  /** Gösterilen ad (arayüz diline göre). */
  name: string;
  cc: string;
  bbox: [number, number, number, number];
  /** Çokgen parçaları; her biri kendi sınır kutusuyla (adalı bölgelerde
   * yalnızca noktanın kutusuna düşen parça denenir). */
  parts: { bbox: [number, number, number, number]; outer: number[][]; holes: number[][][] }[];
}

/** `cc` yoksa Türkiye ili; `en`: İngilizce ad (Türkçeden farklıysa). */
export type ProvinceFC = FeatureCollection<MultiPolygon, { name: string; cc?: string; en?: string }>;
export type CountryFC = FeatureCollection<MultiPolygon, { cc: string }>;

export const PROVINCE_COUNT = 81;

let provincesP: Promise<ProvinceFC> | null = null;
let countriesP: Promise<CountryFC> | null = null;
let worldP: Promise<ProvinceFC> | null = null;
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
/** Türkiye illeri ve öteki ülkelerin birinci düzey bölgeleri (eyalet, bölge,
 * il…) birlikte; yalnızca yurtdışı kayıt varsa yüklenir. */
export function loadWorldRegions(): Promise<ProvinceFC> {
  worldP ??= Promise.all([loadProvinces(), fetch(worldUrl).then((r) => r.json() as Promise<ProvinceFC>)]).then(([tr, world]) => ({
    type: "FeatureCollection",
    features: [...tr.features, ...world.features],
  }));
  return worldP;
}

/** Bölgenin ülkesi (Türkiye illerinde `cc` yazılı değil). */
export const ccOf = (p: { cc?: string }) => p.cc ?? "TR";
/** Bölgenin arayüz dilindeki adı. */
export const regionName = (p: { name: string; en?: string }) => (lang === "en" && p.en) || p.name;
const keyOf = (p: { name: string; cc?: string }) => `${ccOf(p)}|${p.name}`;

/** Ülke başına bölge sayısı (aynı adlı parçalar tek bölge sayılır). */
export function regionCounts(fc: ProvinceFC): Map<string, number> {
  const seen = new Set<string>();
  const out = new Map<string, number>();
  for (const f of fc.features) {
    const k = keyOf(f.properties);
    if (seen.has(k)) continue;
    seen.add(k);
    const cc = ccOf(f.properties);
    out.set(cc, (out.get(cc) ?? 0) + 1);
  }
  return out;
}

/** Bölgeler ve 1°'lik ızgara dizini: her hücrede o hücreye değen bölgeler. */
interface RegionIndex {
  regions: Region[];
  grid: Map<number, Region[]>;
  /** ~1 km'lik hücrelerin sonucu (deniz dahil): aynı yerden geçen kayıtlar
   * ve hiçbir bölgeye düşmeyen noktalar yeniden denenmez. */
  memo: Map<number, Region | null>;
}
const cellOf = (lon: number, lat: number) => (Math.floor(lat) + 90) * 360 + Math.floor(lon) + 180;

const regionCache = new WeakMap<ProvinceFC, RegionIndex>();
function regionsOf(fc: ProvinceFC): RegionIndex {
  let r = regionCache.get(fc);
  if (!r) {
    const regions: Region[] = fc.features.map((f) => {
      const parts = f.geometry.coordinates.map(([outer, ...holes]) => {
        let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of outer) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
        return { bbox: [x0, y0, x1, y1] as [number, number, number, number], outer, holes };
      });
      const bbox: [number, number, number, number] = [
        Math.min(...parts.map((p) => p.bbox[0])),
        Math.min(...parts.map((p) => p.bbox[1])),
        Math.max(...parts.map((p) => p.bbox[2])),
        Math.max(...parts.map((p) => p.bbox[3])),
      ];
      return { key: keyOf(f.properties), name: regionName(f.properties), cc: ccOf(f.properties), bbox, parts };
    });
    const grid = new Map<number, Region[]>();
    for (const g of regions)
      for (const { bbox: b } of g.parts)
        for (let y = Math.floor(b[1]); y <= Math.floor(b[3]); y++)
          for (let x = Math.floor(b[0]); x <= Math.floor(b[2]); x++) {
            const c = cellOf(x, y);
            const list = grid.get(c);
            if (!list) grid.set(c, [g]);
            else if (list[list.length - 1] !== g) list.push(g);
          }
    r = { regions, grid, memo: new Map() };
    regionCache.set(fc, r);
  }
  return r;
}

/** Nokta çokgenin (MultiPolygon koordinatları) içinde mi; delikler hesaba katılır. */
export function inPolygon(lon: number, lat: number, polys: number[][][][]): boolean {
  return polys.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
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
function regionAt(lon: number, lat: number, ix: RegionIndex, hint?: Region | null): Region | null {
  const test = (r: Region) => {
    const [x0, y0, x1, y1] = r.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) return false;
    for (const { bbox: b, outer, holes } of r.parts) {
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      if (inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h))) return true;
    }
    return false;
  };
  const cands = ix.grid.get(cellOf(lon, lat));
  if (!cands) return null;
  const m = Math.round(lat * 100) * 40_000 + Math.round(lon * 100);
  const known = ix.memo.get(m);
  if (known !== undefined) return known;
  // Ardışık noktalar çoğunlukla aynı bölgededir: önce bir öncekine bakılır.
  const r = hint && test(hint) ? hint : (cands.find(test) ?? null);
  if (ix.memo.size > 2_000_000) ix.memo.clear();
  ix.memo.set(m, r);
  return r;
}

/** Kaydın geçtiği bölgeler: her bölgede bulunulan günler (yerel gün → o
 * gündeki ilk an); anahtar `ülke|ad`. Noktalar ~1 km seyreltilerek denenir
 * (sınırdaki birkaç yüz metre ihmal edilir). Zamansız kayıtta gün anahtarı boştur. */
const dayCache = new WeakMap<FileSummary, { fc: ProvinceFC; v: Map<string, Map<string, number | null>> }>();
function provinceDaysOf(s: FileSummary, fc: ProvinceFC): Map<string, Map<string, number | null>> {
  const hit = dayCache.get(s);
  if (hit && hit.fc === fc) return hit.v;
  const ix = regionsOf(fc);
  const zone = tzOf(s);
  const out = new Map<string, Map<string, number | null>>();
  let hint: Region | null = null;
  s.lines.forEach((line, i) => {
    const times = s.times[i];
    let last: [number, number] | null = null;
    let lastRegion: Region | null = null;
    let lastDay = "";
    line.forEach(([lon, lat], j) => {
      const t = times?.[j] ?? s.stats.startTime;
      const day = t != null ? fastDayKey(t, zone) : "";
      // Seyreltme: yakın nokta atlanır, ama gün değişince yeni gün kaydedilsin diye denenir.
      if (last && day === lastDay && Math.abs(lon - last[0]) < 0.01 && Math.abs(lat - last[1]) < 0.008 && j < line.length - 1) return;
      last = [lon, lat];
      const r = regionAt(lon, lat, ix, hint);
      if (!r) return;
      hint = r;
      if (r === lastRegion && day === lastDay) return;
      lastRegion = r;
      lastDay = day;
      let days = out.get(r.key);
      if (!days) out.set(r.key, (days = new Map()));
      const prev = days.get(day);
      if (prev === undefined || (t != null && (prev == null || t < prev))) days.set(day, t ?? null);
    });
  });
  dayCache.set(s, { fc, v: out });
  return out;
}

/** Kaydın geçtiği iller ve her birine ilk girildiği an. */
export function provincesOf(s: FileSummary, fc: ProvinceFC): Map<string, number | null> {
  const out = new Map<string, number | null>();
  for (const [key, days] of provinceDaysOf(s, fc)) {
    const name = key.slice(key.indexOf("|") + 1);
    let first: number | null | undefined;
    for (const t of days.values()) if (first === undefined || (t != null && (first == null || t < first))) first = t;
    out.set(name, first ?? null);
  }
  return out;
}

export interface ProvinceVisit {
  /** `ülke|ad` (benzersiz). */
  key: string;
  /** Arayüz dilindeki ad. */
  name: string;
  cc: string;
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
  const names = new Map(regionsOf(fc).regions.map((r) => [r.key, r]));
  for (const s of files) {
    for (const [key, days] of provinceDaysOf(s, fc)) {
      // Tarih aralığında bulunulan ilk gün: aralıktan önce girilip aralıkta da
      // geçilen il sayılır (çok günlük kayıtlar).
      let day = "";
      let t: number | null = null;
      let found = false;
      for (const [d, at] of days) {
        if ((from || to) && d && !dayIn(d, from, to)) continue;
        if (!found || (at != null && (t == null || at < t))) {
          day = d;
          t = at;
        }
        found = true;
      }
      if (!found) continue;
      const v = m.get(key);
      const r = names.get(key);
      if (!v) m.set(key, { key, name: r?.name ?? key, cc: r?.cc ?? "", first: day, records: 1, at: t });
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
