import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { albumData, ALBUM_PHOTOS } from "./album";
import type { PlacedPhoto } from "./photos";
import type { FileEntry } from "./types";

const H = 3_600_000;
const rec = (path: string, start: number, km: number): FileEntry =>
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
      visits: [],
      hours: [[start, km * 1000, H]],
      stats: { startTime: start, endTime: start + 2 * H, pointCount: 3, distanceM: km * 1000, movingMs: H },
    } as unknown as FileSummary,
  }) as FileEntry;

const photo = (n: number, at: number) => ({ path: `/f/${n}.jpg`, at, record: null }) as unknown as PlacedPhoto;

describe("albumData", () => {
  it("kayıtlı aylar; notlar, kişiler ve aya yayılmış fotoğraflar", () => {
    const jul = Date.UTC(2024, 6, 9, 7);
    const files = [rec("Bodrum", jul, 80), rec("Datça", jul + 72 * H, 60), rec("Ankara", Date.UTC(2024, 2, 1, 8), 400), rec("eski", Date.UTC(2023, 6, 1), 5)];
    const photos = Array.from({ length: 12 }, (_, i) => photo(i, jul + i * H));
    const a = albumData(files, "2024", { "2024-07-10": "Knidos", "2024-08-01": "x" }, { Datça: { tags: [], note: "", activity: null, people: ["Babam"] } }, photos);
    expect(a.map((m) => m.key)).toEqual(["2024-03", "2024-07"]);
    const j = a[1];
    expect(j.records.map((r) => r.name)).toEqual(["Bodrum", "Datça"]);
    expect(j.records[1].people).toEqual(["Babam"]);
    expect(j.distanceM).toBe(140_000);
    expect(j.notes).toEqual([{ day: "2024-07-10", text: "Knidos" }]);
    expect(j.photos).toHaveLength(ALBUM_PHOTOS);
    expect(j.photos[0]).toBe("/f/0.jpg");
    expect(j.photos[1]).toBe("/f/2.jpg");
    expect(a[0].photos).toEqual([]);
  });
});
