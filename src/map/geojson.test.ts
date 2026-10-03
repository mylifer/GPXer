import { describe, expect, it } from "vitest";
import type { FileEntry } from "../types";
import { boundsOf, gapsGeoJSON, heatGeoJSON, nearLon, unwrapLines } from "./geojson";

const entry = (lines: [number, number][][], bbox: [number, number, number, number]) =>
  ({
    color: "#000",
    summary: {
      path: "/a.gpx",
      lines,
      times: lines.map((l) => l.map(() => null)),
      gaps: [{ from: [179.9, -17], to: [-179.9, -17.1], distanceM: 30_000, start: null, end: null }],
      stats: { bbox },
    },
  }) as unknown as FileEntry;

describe("antimeridian", () => {
  it("moves longitudes next to the previous one", () => {
    expect(nearLon(-179.9, 179.9)).toBeCloseTo(180.1);
    expect(nearLon(10, 12)).toBe(10);
  });

  it("keeps tracks that cross ±180° continuous", () => {
    const lines: [number, number][][] = [
      [
        [179.8, -17],
        [179.95, -17],
        [-179.95, -17],
        [-179.8, -17],
      ],
    ];
    const u = unwrapLines(lines, [-179.95, -17, 179.95, -17]);
    expect(u.lines[0].map((p) => p[0])).toEqual([179.8, 179.95, 180.05, 180.2].map((x) => expect.closeTo(x, 6)));
    expect(u.bbox![0]).toBeCloseTo(179.8);
    expect(u.bbox![2]).toBeCloseTo(180.2);
    // Aynı dizi için önbellekten.
    expect(unwrapLines(lines, null)).toBe(u);
    // Geçmeyen kayıtta değişmez.
    const plain: [number, number][][] = [[[29, 41], [29.1, 41]]];
    expect(unwrapLines(plain, null).lines).toBe(plain);

    const f = entry(lines, [-179.95, -17, 179.95, -17]);
    // Isı haritası dünyayı kat eden ~40.000 km'lik bir parça üretmez.
    expect(heatGeoJSON([f], null).features.length).toBeLessThan(2000);
    const b = boundsOf([f]) as [[number, number], [number, number]];
    expect(b[1][0] - b[0][0]).toBeLessThan(1);
    const g = gapsGeoJSON([f], null).features[0].geometry as GeoJSON.LineString;
    expect(g.coordinates[1][0]).toBeCloseTo(180.1);
  });
});

describe("area filter near ±180°", () => {
  it("matches boxes drawn on a neighbouring world copy and across the meridian", async () => {
    const { linesHitBox } = await import("../geo");
    const fiji: [number, number][][] = [
      [
        [179.8, -17],
        [-179.8, -17],
      ],
    ];
    // Doğu kopyasında çizilmiş alan (181..182).
    expect(linesHitBox(fiji, [180.1, -18, 180.3, -16], [-179.8, -17, 179.8, -17])).toBe(true);
    // 180°'nin hemen batısı.
    expect(linesHitBox(fiji, [179.7, -18, 179.9, -16], null)).toBe(true);
    // İstanbul izi uzaktaki alana düşmez.
    expect(linesHitBox([[[29, 41], [29.1, 41]]], [179, -18, 181, -16], null)).toBe(false);
    expect(linesHitBox([[[29, 41], [29.1, 41]]], [388.9, 40, 389.2, 42], null)).toBe(true);
  });
});
