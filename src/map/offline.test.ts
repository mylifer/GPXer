import { describe, expect, it } from "vitest";
import type * as maplibregl from "maplibre-gl";
import { visibleTileUrls } from "./offline";

/** Yalnızca visibleTileUrls'in kullandığı kadarıyla sahte harita. */
const fakeMap = (zoom: number, bounds: [number, number, number, number], sources: Record<string, object>, layers: object[], glyphs: string | null) =>
  ({
    getZoom: () => zoom,
    getBounds: () => ({ getWest: () => bounds[0], getSouth: () => bounds[1], getEast: () => bounds[2], getNorth: () => bounds[3] }),
    getStyle: () => ({ layers }),
    getTerrain: () => null,
    getSource: (id: string) => sources[id],
    getGlyphs: () => glyphs,
  }) as unknown as maplibregl.Map;

describe("visibleTileUrls", () => {
  it("matches the tiles and glyphs MapLibre will request", () => {
    const map = fakeMap(
      8.6,
      [29, 40.9, 29.1, 41],
      {
        topo: { type: "raster", tileSize: 256, maxzoom: 17, tiles: ["https://a.t/{z}/{x}/{y}.png", "https://b.t/{z}/{x}/{y}.png", "https://c.t/{z}/{x}/{y}.png"] },
      },
      [
        { id: "topo", type: "raster", source: "topo" },
        { id: "lbl", type: "symbol", source: "topo", layout: { "text-font": ["literal", ["Noto Sans Regular"]] } },
      ],
      "https://g.t/{fontstack}/{range}.pbf",
    );
    const { urls } = visibleTileUrls(map, 0);
    // 256 px raster karolar zoom+1'e yuvarlanır: 8.6 → 10.
    const tiles = urls.filter((u) => u.endsWith(".png"));
    expect(tiles.length).toBeGreaterThan(0);
    for (const u of tiles) {
      const [, sub, z, x, y] = /https:\/\/(\w)\.t\/(\d+)\/(\d+)\/(\d+)/.exec(u)!;
      expect(z).toBe("10");
      // Alt alan adı MapLibre gibi (x + y) % 3 ile seçilir.
      expect(sub).toBe("abc"[(Number(x) + Number(y)) % 3]);
    }
    expect(urls).toContain("https://g.t/Noto Sans Regular/256-511.pbf");
  });

  it("wraps tiles across the antimeridian", () => {
    const map = fakeMap(4, [170, -20, 190, -10], { v: { type: "vector", tiles: ["https://v/{z}/{x}/{y}"] } }, [{ id: "v", type: "fill", source: "v" }], null);
    const xs = visibleTileUrls(map, 0).urls.map((u) => Number(u.split("/")[4]));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(16);
    expect(xs).toContain(0);
  });
});
