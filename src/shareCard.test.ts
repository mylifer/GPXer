import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { yearCardData } from "./shareCard";
import type { FileEntry } from "./types";

const H = 3_600_000;
const rec = (path: string, start: number, hours: number, km: number): FileEntry =>
  ({
    color: "#000",
    summary: {
      path,
      fileName: `${path}.gpx`,
      name: path,
      activity: "car",
      timeZone: "UTC",
      lines: [[[29, 41], [29.1, 41.1], [29.2, 41.2]]],
      times: [[start, start + H, start + 2 * H]],
      gaps: [],
      visits: [[start, "TR", "İstanbul"]],
      hours: Array.from({ length: hours }, (_, k) => [start + k * H, (km * 1000) / hours, H]),
      stats: { startTime: start, endTime: start + hours * H - 1, pointCount: 100, distanceM: km * 1000, movingMs: hours * H, elevationGainM: 10 },
    } as unknown as FileSummary,
  }) as FileEntry;

describe("yearCardData", () => {
  it("counts only the chosen year and copies once", () => {
    const t = Date.UTC(2023, 3, 1, 8);
    const c = yearCardData(
      [rec("a", t, 3, 300), rec("a kopya", t, 3, 300), rec("b", t + 24 * H, 2, 50), rec("geçen yıl", Date.UTC(2022, 5, 1), 2, 999)],
      "2023",
    );
    expect(c.records).toBe(3);
    expect(Math.round(c.distanceM / 1000)).toBe(350);
    expect(c.days).toBe(2);
    expect(c.countries).toEqual([{ cc: "TR", days: 2 }]);
    expect(c.longest?.distanceM).toBe(300_000);
    expect(c.lines.length).toBe(3);
  });
});
