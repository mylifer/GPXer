/** Bir gezinin kayıtlarını tek bir sanal kayıtta birleştirir; gezi hikâyesi
 * (story.ts) tek kayıtta olduğu gibi üretilebilsin. Kayıtlar arasındaki
 * boşluklar (otelde geçen gece) boşluk olarak kalır: geceler de bulunur. */
import type { Detail, FileSummary, Gap } from "./api";

const sum = (xs: (number | null)[]) => (xs.some((x) => x != null) ? xs.reduce<number>((a, x) => a + (x ?? 0), 0) : null);
const max = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.max(...v) : null;
};
const min = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? Math.min(...v) : null;
};

export function combineRecords(list: FileSummary[], name: string): FileSummary {
  const recs = [...list].sort((a, b) => (a.stats.startTime ?? 0) - (b.stats.startTime ?? 0));
  const first = recs[0];
  const last = recs[recs.length - 1];
  const st = recs.map((s) => s.stats);
  const gaps: Gap[] = recs.flatMap((s) => s.gaps);
  for (let i = 1; i < recs.length; i++) {
    const [a, b] = [recs[i - 1], recs[i]];
    if (!a.end || !b.start) continue;
    gaps.push({ from: a.end, to: b.start, start: a.stats.endTime, end: b.stats.startTime, distanceM: 0, fromPlace: a.endPlace, toPlace: b.startPlace });
  }
  const startTime = min(st.map((x) => x.startTime));
  const endTime = max(st.map((x) => x.endTime));
  const bboxes = st.map((x) => x.bbox).filter((b): b is [number, number, number, number] => b != null);
  const moving = sum(st.map((x) => x.movingMs));
  const dist = st.reduce((a, x) => a + x.distanceM, 0);
  return {
    ...first,
    path: `trip:${first.path}`,
    fileName: name,
    name,
    fileSize: recs.reduce((a, s) => a + s.fileSize, 0),
    trackCount: recs.reduce((a, s) => a + s.trackCount, 0),
    routeCount: 0,
    stats: {
      pointCount: st.reduce((a, x) => a + x.pointCount, 0),
      segmentCount: st.reduce((a, x) => a + x.segmentCount, 0),
      distanceM: dist,
      startTime,
      endTime,
      durationMs: startTime != null && endTime != null ? endTime - startTime : null,
      movingMs: moving,
      avgMovingSpeedMs: moving ? dist / (moving / 1000) : null,
      maxSpeedMs: max(st.map((x) => x.maxSpeedMs)),
      elevationGainM: sum(st.map((x) => x.elevationGainM)),
      elevationLossM: sum(st.map((x) => x.elevationLossM)),
      minEleM: min(st.map((x) => x.minEleM)),
      maxEleM: max(st.map((x) => x.maxEleM)),
      bbox: bboxes.length
        ? [
            Math.min(...bboxes.map((b) => b[0])),
            Math.min(...bboxes.map((b) => b[1])),
            Math.max(...bboxes.map((b) => b[2])),
            Math.max(...bboxes.map((b) => b[3])),
          ]
        : null,
      avgHr: null,
      maxHr: max(st.map((x) => x.maxHr)),
      avgCad: null,
      avgPower: null,
      maxPower: max(st.map((x) => x.maxPower)),
      avgTemp: null,
    },
    lines: recs.flatMap((s) => s.lines),
    times: recs.flatMap((s) => s.times),
    gaps,
    waypoints: recs.flatMap((s) => s.waypoints),
    start: first.start,
    end: last.end,
    startPlace: first.startPlace,
    endPlace: last.endPlace,
    stops: recs.flatMap((s) => s.stops),
    removedPoints: recs.reduce((a, s) => a + s.removedPoints, 0),
    collapsedPoints: recs.reduce((a, s) => a + s.collapsedPoints, 0),
    hours: recs.flatMap((s) => s.hours ?? []).sort((a, b) => a[0] - b[0]),
    visits: recs.flatMap((s) => s.visits ?? []),
  };
}

/** Kayıtların ayrıntılarını (profil için) uç uca ekler; mesafe birikir. */
export function combineDetails(details: Detail[]): Detail {
  const out: Detail = { dist: [], ele: [], speed: [], time: [], lat: [], lon: [], idx: [], hr: [], cad: [], power: [], temp: [], gapAfter: [] };
  let offset = 0;
  for (const d of details) {
    const base = out.dist.length;
    if (base) out.gapAfter.push(base - 1);
    for (const g of d.gapAfter) out.gapAfter.push(base + g);
    out.dist.push(...d.dist.map((x) => x + offset));
    out.idx.push(...d.idx.map((_, i) => base + i));
    for (const k of ["ele", "speed", "time", "lat", "lon", "hr", "cad", "power", "temp"] as const) (out[k] as unknown[]).push(...d[k]);
    offset += d.dist[d.dist.length - 1] ?? 0;
  }
  return out;
}
