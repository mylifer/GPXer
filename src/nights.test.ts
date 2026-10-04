import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { nightsOf } from "./nights";

const H = 3_600_000;
// İstanbul saatiyle 10 Aralık 2023 20:00 = 17:00 UTC.
const eve = Date.UTC(2023, 11, 10, 17);

describe("nightsOf", () => {
  it("finds overnight stops and overnight recording gaps", () => {
    const s = {
      timeZone: "Europe/Istanbul",
      stops: [
        { lat: 39.9, lon: 32.8, start: eve, durationMs: 12 * H }, // gece Ankara
        { lat: 40, lon: 33, start: eve + 16 * H, durationMs: 5 * H }, // gündüz uzun mola
      ],
      gaps: [
        // Ertesi gece telefon kapalı, aynı yerde açıldı.
        { from: [35.5, 38.7], to: [35.501, 38.7], start: eve + 25 * H, end: eve + 36 * H, distanceM: 90 },
        // Uçuş: başka yerde sürüyor, konaklama değil.
        { from: [29, 41], to: [7, 50], start: eve + 49 * H, end: eve + 60 * H, distanceM: 2e6 },
      ],
      visits: [
        [eve - H, "TR", "Ankara"],
        [eve + 24 * H, "TR", "Kayseri"],
      ],
    } as unknown as FileSummary;
    const n = nightsOf(s);
    expect(n.map((x) => x.place)).toEqual(["Ankara", "Kayseri"]);
    expect(n[1].start).toBe(eve + 25 * H);
  });
});
