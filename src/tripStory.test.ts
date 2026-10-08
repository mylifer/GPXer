import { describe, expect, it } from "vitest";
import type { Detail, FileSummary } from "./api";
import { nightsOf } from "./nights";
import { combineDetails, combineRecords } from "./tripStory";

const H = 3_600_000;
const rec = (path: string, t0: number, a: [number, number], b: [number, number], ap: string, bp: string, km: number) =>
  ({
    path,
    fileName: `${path}.gpx`,
    name: null,
    fileSize: 100,
    trackCount: 1,
    routeCount: 0,
    timeZone: "Europe/Istanbul",
    lines: [[a, b]],
    times: [[t0, t0 + 3 * H]],
    gaps: [],
    waypoints: [],
    start: a,
    end: b,
    startPlace: ap,
    endPlace: bp,
    stops: [],
    removedPoints: 0,
    collapsedPoints: 0,
    activity: "car",
    activitySet: false,
    stats: {
      pointCount: 2,
      segmentCount: 1,
      distanceM: km * 1000,
      startTime: t0,
      endTime: t0 + 3 * H,
      durationMs: 3 * H,
      movingMs: 3 * H,
      avgMovingSpeedMs: 10,
      maxSpeedMs: 30,
      elevationGainM: 100,
      elevationLossM: 90,
      minEleM: 10,
      maxEleM: 500,
      bbox: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])],
      avgHr: null,
      maxHr: null,
      avgCad: null,
      avgPower: null,
      maxPower: null,
      avgTemp: null,
    },
  }) as unknown as FileSummary;

describe("trip story", () => {
  const t0 = Date.UTC(2024, 6, 9, 6);
  const a = rec("a", t0, [27.43, 37.04], [28.27, 36.85], "Bodrum", "Marmaris", 160);
  // Ertesi sabah aynı yerden (otel) devam.
  const b = rec("b", t0 + 24 * H, [28.27, 36.85], [27.69, 36.73], "Marmaris", "Datça", 75);

  it("sums stats and keeps order", () => {
    const s = combineRecords([b, a], "Muğla gezisi");
    expect(s.name).toBe("Muğla gezisi");
    expect(s.stats.distanceM).toBe(235_000);
    expect(s.stats.elevationGainM).toBe(200);
    expect(s.startPlace).toBe("Bodrum");
    expect(s.endPlace).toBe("Datça");
    expect(s.stats.durationMs).toBe(27 * H);
    expect(s.stats.bbox).toEqual([27.43, 36.73, 28.27, 37.04]);
  });

  it("the night between records is found", () => {
    const n = nightsOf(combineRecords([a, b], "x"));
    expect(n).toHaveLength(1);
    expect(n[0].start).toBe(t0 + 3 * H);
  });

  it("joins details with cumulative distance", () => {
    const d = (n: number): Detail => ({
      dist: [0, n],
      ele: [1, 2],
      speed: [1, 1],
      time: [0, 1],
      lat: [0, 0],
      lon: [0, 0],
      idx: [0, 1],
      hr: [null, null],
      cad: [null, null],
      power: [null, null],
      temp: [null, null],
      gapAfter: [],
    });
    const c = combineDetails([d(100), d(50)]);
    expect(c.dist).toEqual([0, 100, 100, 150]);
    expect(c.idx).toEqual([0, 1, 2, 3]);
    expect(c.gapAfter).toEqual([1]);
  });
});
