/** Haritaya verilen GeoJSON verilerini kuran saf yardımcılar. */
import type { LngLatBoundsLike } from "maplibre-gl";
import type { Detail, FileSummary, NamedPlace } from "../api";
import type { FileEntry } from "../types";
import { fastDayKey, tzOf } from "../format";
import type { BBox } from "../geo";
import { clipToRange, dayIn } from "../days";
import { greatCircle, type Flight } from "../flights";
import { namedPlaceAt } from "../places";

export const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Tarih filtresi: aralığın dışına taşan kayıtların yalnızca aralıktaki kısmı çizilir. */
export interface DateWindow {
  from: string;
  to: string;
}

const geoOf = (f: FileEntry, win: DateWindow | null) =>
  win ? clipToRange(f.summary, win.from, win.to) : { lines: f.summary.lines, gaps: f.summary.gaps ?? [], bbox: f.summary.stats.bbox };

export function tracksGeoJSON(files: FileEntry[], win: DateWindow | null): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: files.map((f) => ({
      type: "Feature",
      properties: { path: f.summary.path, color: f.color },
      geometry: { type: "MultiLineString", coordinates: geoOf(f, win).lines },
    })),
  };
}

export function gapsGeoJSON(files: FileEntry[], win: DateWindow | null): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of files) {
    for (const g of geoOf(f, win).gaps) {
      features.push({
        type: "Feature",
        properties: {
          path: f.summary.path,
          color: f.color,
          start: g.start ?? 0,
          end: g.end ?? 0,
          dist: g.distanceM,
          tz: f.summary.timeZone ?? "",
        },
        geometry: { type: "LineString", coordinates: [g.from, g.to] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

export function waypointsGeoJSON(files: FileEntry[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of files) {
    for (const w of f.summary.waypoints) {
      features.push({
        type: "Feature",
        properties: { path: f.summary.path, color: f.color, name: w.name ?? "" },
        geometry: { type: "Point", coordinates: [w.lon, w.lat] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Isı haritası için izleri eşit aralıklı noktalara böler; böylece virajlı
 * yerler (sadeleştirmede daha çok nokta kalır) olduğundan yoğun görünmez. */
export function heatGeoJSON(files: FileEntry[], win: DateWindow | null, stepM = 40): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of files) {
    for (const line of geoOf(f, win).lines) {
      let carry = 0;
      for (let j = 0; j + 1 < line.length; j++) {
        const [x0, y0] = line[j];
        const [x1, y1] = line[j + 1];
        const kx = 111_320 * Math.cos((y0 * Math.PI) / 180);
        const seg = Math.hypot((x1 - x0) * kx, (y1 - y0) * 110_574);
        let t = stepM - carry;
        while (t <= seg) {
          const r = t / seg;
          features.push({
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [x0 + (x1 - x0) * r, y0 + (y1 - y0) * r] },
          });
          t += stepM;
        }
        carry = (carry + seg) % stepM;
      }
    }
  }
  return { type: "FeatureCollection", features };
}

export function boundsOf(files: FileEntry[], win: DateWindow | null = null): LngLatBoundsLike | null {
  let b: [number, number, number, number] | null = null;
  for (const f of files) {
    const x = geoOf(f, win).bbox;
    if (!x) continue;
    b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : [...x];
  }
  return b ? [[b[0], b[1]], [b[2], b[3]]] : null;
}

/** Renklendirme için değer aralığı: uç değerler (GPS sıçramaları) skalayı
 * bozmasın diye %5–%95 dilimleri alınır. */
export function metricDomain(values: (number | null)[]): [number, number] | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const lo = v[Math.floor(v.length * 0.05)];
  const hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** İmlecin altındaki noktanın zamanı: çizginin en yakın parçası bulunur ve
 * iki ucunun zamanı arasında konuma göre doğrusal ara değer alınır. */
export function timeAt(summary: FileSummary, lon: number, lat: number): number | null {
  const { lines, times } = summary;
  if (times.length === 0) return null;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let bestLine = -1;
  let bestIdx = 0;
  let bestT = 0;
  lines.forEach((line, li) => {
    for (let j = 0; j + 1 < line.length; j++) {
      const ax = line[j][0] * kx;
      const ay = line[j][1];
      const dx = line[j + 1][0] * kx - ax;
      const dy = line[j + 1][1] - ay;
      const px = lon * kx - ax;
      const py = lat - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d2 < best) {
        best = d2;
        bestLine = li;
        bestIdx = j;
        bestT = t;
      }
    }
  });
  if (bestLine < 0) return null;
  const ta = times[bestLine]?.[bestIdx] ?? null;
  const tb = times[bestLine]?.[bestIdx + 1] ?? null;
  if (ta != null && tb != null) return Math.round(ta + (tb - ta) * bestT);
  return bestT < 0.5 ? (ta ?? tb) : (tb ?? ta);
}

/** Detay örnekleri arasında imlece en yakın olanın sırası. */
export function nearestDetail(d: Detail, lon: number, lat: number): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let idx = 0;
  for (let i = 0; i < d.lat.length; i++) {
    const dd = ((d.lon[i] - lon) * kx) ** 2 + (d.lat[i] - lat) ** 2;
    if (dd < best) {
      best = dd;
      idx = i;
    }
  }
  return idx;
}

/** Seçili kaydın duraklamaları. */
export function stopsGeoJSON(entry: FileEntry | undefined, win: DateWindow | null, places: NamedPlace[]): GeoJSON.FeatureCollection {
  const zone = entry ? tzOf(entry.summary) : undefined;
  const stops = (entry?.summary.stops ?? []).filter((st) => !win || dayIn(fastDayKey(st.start, zone), win.from, win.to));
  return {
    type: "FeatureCollection",
    features: stops.map((st) => ({
      type: "Feature",
      properties: {
        kind: "stop",
        start: st.start,
        dur: st.durationMs,
        tz: entry?.summary.timeZone ?? "",
        name: namedPlaceAt(st.lon, st.lat, places)?.name ?? "",
      },
      geometry: { type: "Point", coordinates: [st.lon, st.lat] },
    })),
  };
}

/** Tüm kayıtların duraklamaları ~150 m'lik hücrelerde toplanır. */
export function hotspotsGeoJSON(files: FileEntry[], places: NamedPlace[]): GeoJSON.FeatureCollection {
  const cells = new Map<string, { lon: number; lat: number; n: number; dur: number; files: Set<string> }>();
  const size = 0.0015;
  for (const f of files) {
    for (const st of f.summary.stops) {
      const key = `${Math.round(st.lon / size)}:${Math.round(st.lat / size)}`;
      const c = cells.get(key) ?? { lon: 0, lat: 0, n: 0, dur: 0, files: new Set<string>() };
      c.lon += st.lon;
      c.lat += st.lat;
      c.n++;
      c.dur += st.durationMs;
      c.files.add(f.summary.path);
      cells.set(key, c);
    }
  }
  return {
    type: "FeatureCollection",
    features: [...cells.values()].map((c) => ({
      type: "Feature",
      properties: {
        kind: "hot",
        n: c.n,
        dur: c.dur,
        files: c.files.size,
        name: namedPlaceAt(c.lon / c.n, c.lat / c.n, places)?.name ?? "",
      },
      geometry: { type: "Point", coordinates: [c.lon / c.n, c.lat / c.n] },
    })),
  };
}

export function areaGeoJSON(b: BBox | null): GeoJSON.FeatureCollection {
  if (!b) return EMPTY;
  const ring = [
    [b[0], b[1]],
    [b[2], b[1]],
    [b[2], b[3]],
    [b[0], b[3]],
    [b[0], b[1]],
  ];
  return {
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
  };
}

export function flightsGeoJSON(flights: Flight[] | null, color: (path: string) => string): GeoJSON.FeatureCollection {
  if (!flights?.length) return EMPTY;
  return {
    type: "FeatureCollection",
    features: flights.map((f, i) => ({
      type: "Feature",
      properties: { i, path: f.path, color: color(f.path) },
      geometry: { type: "LineString", coordinates: greatCircle(f.from, f.to) },
    })),
  };
}

/** Kayıt boşluğunun (uçuş, sinyal kaybı) iki yakasındaki ardışık örnek
 *  çiftleri: `i` kümedeyse `i` ile `i + 1` arasında çizgi kesilir. Boşluklar
 *  gpx-core'da asıl noktalar üzerinde bulunur (Detail.gapAfter). */
export const gapSteps = (d: Detail): Set<number> => new Set(d.gapAfter);

/** Seçili izin ölçüye göre renklendirilmiş parçaları (boşluklarda kesilir). */
export function coloredGeoJSON(
  detail: Detail,
  values: (number | null)[],
  [lo, hi]: [number, number],
  ramp: string[],
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  const gaps = gapSteps(detail);
  for (let i = 0; i + 1 < detail.lat.length; i++) {
    const v = values[i];
    if (v == null || gaps.has(i)) continue;
    const t = (v - lo) / (hi - lo);
    const k = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
    features.push({
      type: "Feature",
      properties: { c: ramp[k] },
      geometry: {
        type: "LineString",
        coordinates: [
          [detail.lon[i], detail.lat[i]],
          [detail.lon[i + 1], detail.lat[i + 1]],
        ],
      },
    });
  }
  return { type: "FeatureCollection", features };
}

/** Grafikte seçilen aralığın çizgisi. */
export function rangeGeoJSON(detail: Detail, range: [number, number]): GeoJSON.Feature {
  // Kayıt boşluklarında çizgi kesilir; boşluğun üstü düz çizgiyle birleştirilmez.
  const gaps = gapSteps(detail);
  const lines: [number, number][][] = [];
  let cur: [number, number][] = [];
  const last = Math.min(range[1], detail.lat.length - 1);
  for (let i = Math.max(0, range[0]); i <= last; i++) {
    cur.push([detail.lon[i], detail.lat[i]]);
    if (i < last && gaps.has(i)) {
      if (cur.length > 1) lines.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) lines.push(cur);
  return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: lines } };
}
