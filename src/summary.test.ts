import { describe, expect, it } from "vitest";
import type { FileSummary, NamedPlace } from "./api";
import { placeStats } from "./summary";
import type { FileEntry } from "./types";

const H = 3_600_000;

describe("placeStats", () => {
  it("counts days, visits and time per named place and city", () => {
    const t = Date.UTC(2023, 4, 1, 8);
    const home: NamedPlace = { id: "ev", name: "Ev", lat: 41, lon: 29, radiusM: 200 };
    const s = {
      path: "a",
      timeZone: "UTC",
      stats: { startTime: t, endTime: t + 50 * H },
      stops: [
        { lat: 41, lon: 29, start: t, durationMs: 2 * H },
        { lat: 41, lon: 29, start: t + 48 * H, durationMs: H },
      ],
      hours: [
        [t, 1000, H],
        [t + 24 * H, 1000, H],
        [t + 48 * H, 1000, H],
      ],
      visits: [
        [t, "TR", "İstanbul"],
        [t + 24 * H, "TR", "Bolu"],
        [t + 48 * H, "TR", "İstanbul"],
      ],
    } as unknown as FileSummary;
    const r = placeStats([{ summary: s } as FileEntry], [home], "", "");
    expect(r.named[0]).toMatchObject({ name: "Ev", days: 2, visits: 2, ms: 3 * H, first: "2023-05-01", last: "2023-05-03" });
    const ist = r.cities.find((c) => c.name === "İstanbul")!;
    expect(ist.days).toBe(2);
    expect(ist.visits).toBe(2);
  });
});
