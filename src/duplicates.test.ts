import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { findDuplicates } from "./duplicates";

const H = 3_600_000;
const rec = (path: string, start: number, hours: number, points: number): FileSummary =>
  ({
    path,
    hours: Array.from({ length: hours }, (_, k) => [start + k * H, 1000, H]),
    stats: { startTime: start, endTime: start + hours * H - 1, pointCount: points, distanceM: hours * 1000 },
  }) as unknown as FileSummary;

describe("findDuplicates", () => {
  it("groups copies and contained versions, keeps the covering one", () => {
    const t = Date.UTC(2019, 5, 4);
    const g = findDuplicates([
      rec("trip", t, 10, 1000),
      rec("trip kopya", t, 10, 1000),
      rec("trip uzun", t, 20, 2000),
      rec("parça", t + 2 * H, 2, 50),
      // Aynı dönemin çok daha seyrek kaydı: kopya değil.
      rec("seyrek geçmiş", t - 100 * H, 300, 600),
      // Başka bir gün.
      rec("başka", t + 100 * H, 5, 500),
    ]);
    expect(g.length).toBe(1);
    expect(g[0].keep).toEqual(["trip uzun"]);
    expect([...g[0].paths].sort()).toEqual(["parça", "trip", "trip kopya", "trip uzun"]);
  });

  it("does not group separate short recordings in the same hour", () => {
    const t = Date.UTC(2023, 6, 9, 17, 47);
    const short = (p: string, s: number) =>
      ({
        path: p,
        hours: [[Date.UTC(2023, 6, 9, 17), 10, 10_000]],
        stats: { startTime: s, endTime: s + 9_000, pointCount: 10, distanceM: 10 },
      }) as unknown as FileSummary;
    expect(findDuplicates([short("a", t), short("b", t + 120_000)])).toEqual([]);
  });
});
