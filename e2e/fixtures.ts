/** Uçtan uca testler için yapay kayıtlar: gerçek şehirler arasında, gürültülü
 * düz çizgilerden oluşan sürüşler. Kişisel veri içermez. */
import type { Detail, FileSummary } from "../src/api";

type Pt = [number, number];

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
function dist([lo1, la1]: Pt, [lo2, la2]: Pt): number {
  const a = Math.sin(rad(la2 - la1) / 2) ** 2 + Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(rad(lo2 - lo1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Durak noktalarından geçen, ~60 km/sa hızla dakikada bir noktalık iz. */
function route(stops: Pt[], seed: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1], stops[i]];
    const n = Math.max(2, Math.round(dist(a, b) / 1000));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const wob = Math.sin((k + seed) / 7) * 0.004;
      out.push([a[0] + (b[0] - a[0]) * f + wob, a[1] + (b[1] - a[1]) * f - wob]);
    }
  }
  out.push(stops[stops.length - 1]);
  return out;
}

interface Trip {
  name: string;
  stops: Pt[];
  start: string;
  visits: [string, string][];
}

const PLACES: Record<string, Pt> = {
  kadikoy: [29.03, 40.99],
  izmit: [29.92, 40.77],
  ankara: [32.85, 39.92],
  eskisehir: [30.52, 39.78],
  bodrum: [27.43, 37.04],
  marmaris: [28.27, 36.85],
  datca: [27.69, 36.73],
  edirne: [26.56, 41.68],
  plovdiv: [24.75, 42.15],
  selanik: [22.94, 40.64],
  munih: [11.58, 48.14],
  augsburg: [10.9, 48.37],
};

export const TRIPS: Trip[] = [
  { name: "İstanbul → Ankara", stops: [PLACES.kadikoy, PLACES.izmit, PLACES.ankara], start: "2023-05-01T06:00:00Z", visits: [["TR", "Kadıköy"], ["TR", "İzmit"], ["TR", "Ankara"]] },
  { name: "Ankara → Eskişehir", stops: [PLACES.ankara, PLACES.eskisehir], start: "2023-05-03T08:00:00Z", visits: [["TR", "Ankara"], ["TR", "Eskişehir"]] },
  { name: "Bodrum → Marmaris", stops: [PLACES.bodrum, PLACES.marmaris], start: "2024-07-09T07:00:00Z", visits: [["TR", "Bodrum"], ["TR", "Marmaris"]] },
  { name: "Marmaris → Datça", stops: [PLACES.marmaris, PLACES.datca], start: "2024-07-10T09:00:00Z", visits: [["TR", "Marmaris"], ["TR", "Datça"]] },
  { name: "Datça → Bodrum", stops: [PLACES.datca, PLACES.bodrum], start: "2024-07-12T10:00:00Z", visits: [["TR", "Datça"], ["TR", "Bodrum"]] },
  { name: "Edirne → Selanik", stops: [PLACES.edirne, PLACES.plovdiv, PLACES.selanik], start: "2025-08-14T05:00:00Z", visits: [["TR", "Edirne"], ["BG", "Plovdiv"], ["GR", "Selanik"]] },
  { name: "Münih → Augsburg", stops: [PLACES.munih, PLACES.augsburg], start: "2025-09-20T09:00:00Z", visits: [["DE", "Münih"], ["DE", "Augsburg"]] },
];

const STEP_MS = 60_000;

export function summary(t: Trip, i: number): FileSummary {
  const pts = route(t.stops, i);
  const t0 = Date.parse(t.start);
  const times = pts.map((_, k) => t0 + k * STEP_MS);
  let d = 0;
  for (let k = 1; k < pts.length; k++) d += dist(pts[k - 1], pts[k]);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  const dur = times[times.length - 1] - t0;
  const visits: [number, string, string][] = t.visits.map(([cc, n], k) => [t0 + Math.round((k * dur) / t.visits.length / 3_600_000) * 3_600_000, cc, n]);
  return {
    path: `/kutuphane/kayit-${i + 1}.gpx`,
    fileName: `kayit-${i + 1}.gpx`,
    name: t.name,
    fileSize: pts.length * 80,
    trackCount: 1,
    routeCount: 0,
    stats: {
      pointCount: pts.length,
      segmentCount: 1,
      distanceM: d,
      startTime: t0,
      endTime: times[times.length - 1],
      durationMs: dur,
      movingMs: dur,
      avgMovingSpeedMs: d / (dur / 1000),
      maxSpeedMs: 30,
      elevationGainM: 120,
      elevationLossM: 110,
      minEleM: 10,
      maxEleM: 900,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)],
      avgHr: null,
      maxHr: null,
      avgCad: null,
      avgPower: null,
      maxPower: null,
      avgTemp: null,
    },
    lines: [pts],
    times: [times],
    gaps: [],
    waypoints: [],
    timeZone: t.visits[0][0] === "TR" ? "Europe/Istanbul" : "Europe/Berlin",
    start: pts[0],
    end: pts[pts.length - 1],
    startPlace: t.visits[0][1],
    endPlace: t.visits[t.visits.length - 1][1],
    activity: "car",
    activitySet: false,
    stops: [],
    removedPoints: 0,
    collapsedPoints: 0,
    hours: [],
    visits,
  };
}

export function detail(s: FileSummary): Detail {
  const pts = s.lines[0];
  const times = s.times[0];
  let acc = 0;
  const dists = pts.map((p, k) => (k ? (acc += dist(pts[k - 1], p)) : 0));
  const none = pts.map(() => null);
  return {
    dist: dists,
    ele: pts.map((_, k) => 100 + Math.sin(k / 20) * 50),
    speed: pts.map(() => 16.7),
    time: times,
    lat: pts.map((p) => p[1]),
    lon: pts.map((p) => p[0]),
    idx: pts.map((_, k) => k),
    hr: none,
    cad: none,
    power: none,
    temp: none,
    gapAfter: [],
  };
}

export const SUMMARIES: FileSummary[] = TRIPS.map(summary);
