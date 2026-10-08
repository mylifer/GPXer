import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import type { FileEntry } from "./types";
import { memoryText, onThisDay } from "./onThisDay";

const H = 3_600_000;
const entry = (path: string, start: number, km: number, from: string, to: string) =>
  ({
    summary: {
      path,
      fileName: `${path}.gpx`,
      name: null,
      timeZone: "Europe/Istanbul",
      startPlace: from,
      endPlace: to,
      hours: [[start, km * 1000, H]],
      stats: { startTime: start, endTime: start + H, distanceM: km * 1000, movingMs: H },
      lines: [],
      times: [],
    } as unknown as FileSummary,
  }) as unknown as FileEntry;

describe("on this day", () => {
  const a = entry("a", Date.UTC(2024, 6, 10, 6), 160, "Bodrum", "Marmaris");
  const b = entry("b", Date.UTC(2022, 6, 10, 9), 20, "Kadıköy", "Kadıköy");
  const c = entry("c", Date.UTC(2024, 6, 11, 6), 75, "Marmaris", "Datça");
  const d = entry("d", Date.UTC(2025, 6, 10, 6), 5, "Kadıköy", "Ataşehir");

  it("finds records on the same day of earlier years, nearest first", () => {
    const m = onThisDay([a, b, c, d], "2025-07-10");
    expect(m.map((x) => [x.years, x.entries.map((e) => e.summary.path)])).toEqual([
      [1, ["a"]],
      [3, ["b"]],
    ]);
    expect(memoryText(m[0])).toBe("Bodrum → Marmaris · 160,0 km");
    expect(onThisDay([a, b, c, d], "2025-07-12")).toEqual([]);
  });
});
