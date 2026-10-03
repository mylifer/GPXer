/** Testler için örnek özet üreticisi (uygulamada kullanılmaz). */

import type { FileSummary, Stats } from "./api";

type Partial2 = Omit<Partial<FileSummary>, "stats"> & { stats?: Partial<Stats> };

export function summary(path: string, o: Partial2 = {}): FileSummary {
  const { stats, ...rest } = o;
  return {
    path,
    fileName: path.split("/").pop() ?? path,
    name: null,
    fileSize: 0,
    trackCount: 1,
    routeCount: 0,
    lines: [],
    times: [],
    gaps: [],
    waypoints: [],
    timeZone: null,
    start: null,
    end: null,
    startPlace: null,
    endPlace: null,
    activity: "unknown",
    activitySet: false,
    stops: [],
    removedPoints: 0,
    collapsedPoints: 0,
    ...rest,
    stats: {
      pointCount: 0,
      segmentCount: 1,
      distanceM: 0,
      startTime: null,
      endTime: null,
      durationMs: null,
      movingMs: null,
      avgMovingSpeedMs: null,
      maxSpeedMs: null,
      elevationGainM: null,
      elevationLossM: null,
      minEleM: null,
      maxEleM: null,
      bbox: null,
      avgHr: null,
      maxHr: null,
      avgCad: null,
      avgPower: null,
      maxPower: null,
      avgTemp: null,
      ...stats,
    },
  };
}

/** Boylam boyunca `n` noktalı düz çizgi ve eşit aralıklı zamanlar. */
export function straightLine(
  from: [number, number],
  to: [number, number],
  n: number,
  t0?: number,
  stepMs = 60_000,
): { lines: [number, number][][]; times: (number | null)[][] } {
  const line: [number, number][] = [];
  const times: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const r = i / (n - 1);
    line.push([from[0] + (to[0] - from[0]) * r, from[1] + (to[1] - from[1]) * r]);
    times.push(t0 == null ? null : t0 + i * stepMs);
  }
  return { lines: [line], times: [t0 == null ? [] : times] };
}
