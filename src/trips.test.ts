import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { detectTrips, homeOf } from "./trips";

const H = 3_600_000;
const HOME: [number, number] = [29.03, 40.99]; // Kadıköy
const rec = (path: string, start: number, a: [number, number], b: [number, number], ap: string, bp: string) =>
  ({
    path,
    timeZone: "Europe/Istanbul",
    start: a,
    end: b,
    startPlace: ap,
    endPlace: bp,
    stats: { startTime: start, endTime: start + 2 * H, bbox: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] },
  }) as unknown as FileSummary;

describe("trips", () => {
  const day = (d: number, h = 8) => Date.UTC(2024, 6, d, h - 3);
  const work: [number, number] = [29.1, 41.07];
  const commute = [1, 2, 3, 4, 5, 8, 9].map((d) => rec(`c${d}`, day(d), HOME, work, "Kadıköy", "Ataşehir"));
  const trip = [
    rec("t1", day(10), HOME, [29.92, 40.77], "Kadıköy", "İzmit"),
    rec("t2", day(10, 14), [29.92, 40.77], [32.85, 39.92], "İzmit", "Ankara"),
    rec("t3", day(11), [32.85, 39.92], [34.83, 38.64], "Ankara", "Göreme"),
    rec("t4", day(13), [34.83, 38.64], HOME, "Göreme", "Kadıköy"),
  ];
  const later = rec("c20", day(20), HOME, work, "Kadıköy", "Ataşehir");

  it("finds home from where days start", () => {
    const h = homeOf([...commute, ...trip, later])!;
    expect(Math.abs(h[0] - HOME[0])).toBeLessThan(0.05);
  });

  it("groups away records into a trip named after the farthest place", () => {
    const t = detectTrips([...commute, ...trip, later]);
    expect(t).toHaveLength(1);
    expect(t[0].paths).toEqual(["t1", "t2", "t3", "t4"]);
    expect(t[0].label).toBe("Göreme gezisi · 10–13.07");
  });

  it("splits trips separated by a long gap", () => {
    const second = rec("s1", day(25), HOME, [27.43, 37.04], "Kadıköy", "Bodrum");
    const t = detectTrips([...commute, ...trip, later, second]);
    expect(t.map((x) => x.paths)).toEqual([["t1", "t2", "t3", "t4"], ["s1"]]);
  });

  it("no trips without a home", () => {
    expect(detectTrips([trip[0]])).toEqual([]);
  });
});
