import { describe, expect, it } from "vitest";
import raw from "./assets/geo/tr-iller.geojson?raw";
import type { ProvinceFC } from "./regions";
import { tilesInBox, tilesInPolygon } from "./streetTiles";

describe("street tiles", () => {
  it("covers a box with z14 tiles", () => {
    // Kadıköy çevresi (~5×3 km).
    const t = tilesInBox([29.02, 40.97, 29.08, 41.0]);
    expect(t.length).toBeGreaterThan(4);
    expect(t.length).toBeLessThan(20);
    expect(t).toContainEqual([9513, 6144]);
  });

  it("keeps only tiles inside a province", () => {
    const fc = JSON.parse(raw) as ProvinceFC;
    const ist = fc.features.find((f) => f.properties.name === "İstanbul")!;
    const t = tilesInPolygon(ist.geometry.coordinates);
    const [w, s, e, n] = [27.97, 40.8, 29.93, 41.6];
    const box = tilesInBox([w, s, e, n]);
    // İl sınırı kutudan belirgin biçimde az karo (deniz ve komşu iller dışarıda).
    expect(t.length).toBeGreaterThan(1000);
    expect(t.length).toBeLessThan(box.length * 0.8);
    expect(t).toContainEqual([9513, 6144]);
  });
});
