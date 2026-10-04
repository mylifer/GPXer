import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { dayTimeline } from "./dayTimeline";
import { setTzMode } from "./format";

const H = 3_600_000;
const M = 60_000;

describe("dayTimeline", () => {
  it("splits a day into stops, moves and unrecorded time", () => {
    setTzMode("record");
    // İstanbul 1 Mayıs 2023: 08:00–18:00 kayıt; 12:00–13:00 mola. (UTC+3)
    const day0 = Date.UTC(2023, 4, 1, 5);
    const s = {
      path: "a",
      timeZone: "Europe/Istanbul",
      stats: { startTime: day0, endTime: day0 + 10 * H },
      stops: [{ lat: 40, lon: 30, start: day0 + 4 * H, durationMs: H }],
      hours: Array.from({ length: 10 }, (_, k) => [day0 + k * H, k === 4 ? 0 : 50_000, k === 4 ? 0 : H]),
      visits: [
        [day0, "TR", "İstanbul"],
        [day0 + 4 * H, "TR", "Bolu"],
        [day0 + 9 * H, "TR", "Ankara"],
      ],
      gaps: [],
    } as unknown as FileSummary;
    const items = dayTimeline([s, { ...s, path: "kopya" }], "2023-05-01", []);
    expect(items.map((x) => x.kind)).toEqual(["none", "move", "stop", "move", "none"]);
    const [, m1, st, m2] = items;
    expect(st.kind === "stop" && st.place).toBe("Bolu");
    expect(m1.kind === "move" && Math.round(m1.distanceM / 1000)).toBe(200);
    expect(m1.kind === "move" && m1.from).toBe("İstanbul");
    expect(m2.kind === "move" && m2.to).toBe("Ankara");
    expect(st.end - st.start).toBe(60 * M);
    setTzMode("local");
  });
});
