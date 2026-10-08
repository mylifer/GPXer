import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { cellOf, venueBook, visitStops } from "./venues";

const H = 3_600_000;
const sum = (stops: { lon: number; lat: number; start: number; durationMs: number }[]) =>
  ({ timeZone: "UTC", stops }) as unknown as FileSummary;

describe("ziyaret defteri", () => {
  it("uzunca duraklar hücrelerine göre mekâna bağlanır; günler bir kez sayılır", () => {
    const d1 = Date.UTC(2024, 4, 1, 9);
    const d2 = Date.UTC(2024, 5, 3, 9);
    const stops = visitStops([
      sum([
        { lon: 29.0251, lat: 40.9801, start: d1, durationMs: H },
        { lon: 29.0252, lat: 40.9802, start: d1 + 3 * H, durationMs: 20 * 60_000 },
        { lon: 29.0252, lat: 40.9802, start: d1 + 5 * H, durationMs: 60_000 },
      ]),
      sum([{ lon: 29.0251, lat: 40.9801, start: d2, durationMs: 30 * 60_000 }]),
    ]);
    expect(stops).toHaveLength(3);
    const book = venueBook(stops, new Map([[cellOf(29.0251, 40.9801), { name: "Moda Çay Bahçesi", kind: "cafe" }]]));
    expect(book).toEqual([
      expect.objectContaining({ name: "Moda Çay Bahçesi", visits: 2, totalMs: H + 50 * 60_000, first: "2024-05-01", last: "2024-06-03" }),
    ]);
  });
});
