import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { drivingHabits } from "./habits";

const H = 3_600_000;

describe("drivingHabits", () => {
  it("bins distance by local hour and finds the longest non-stop drive", () => {
    // İstanbul saatiyle Pazartesi 1 Mayıs 2023 22:00 (19:00 UTC) başlayan 3 saatlik sürüş.
    const t = Date.UTC(2023, 4, 1, 19);
    const s = {
      path: "a",
      timeZone: "Europe/Istanbul",
      hours: [
        [t, 80_000, H],
        [t + H, 90_000, H],
        [t + 2 * H, 70_000, H],
      ],
      stats: { startTime: t, endTime: t + 3 * H },
      stops: [{ lat: 0, lon: 0, start: t + 90 * 60_000, durationMs: 20 * 60_000 }],
      gaps: [],
    } as unknown as FileSummary;
    const h = drivingHabits([s, { ...s, path: "kopya" }], "", "");
    expect(h.byHour[22]).toBe(80_000);
    expect(h.byHour[0]).toBe(70_000);
    expect(h.totalM).toBe(240_000);
    expect(h.nightShare).toBe(1);
    expect(h.byWeekday[0]).toBe(80_000 + 90_000);
    expect(h.byWeekday[1]).toBe(70_000);
    expect(h.longest?.ms).toBe(90 * 60_000);
    expect(Math.round(h.speedByHour[23]!)).toBe(90);
  });
});
