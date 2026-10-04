import { describe, expect, it } from "vitest";
import { isWms, tileUrl, validLayerUrl } from "./customLayers";

describe("custom layers", () => {
  it("accepts XYZ templates and completes WMS urls", () => {
    expect(validLayerUrl("https://tiles.example.com/{z}/{x}/{y}.png")).toBeNull();
    expect(validLayerUrl("ftp://x/{z}/{x}/{y}")).not.toBeNull();
    expect(validLayerUrl("https://x.com/tiles/{z}/{x}.png")).not.toBeNull();
    const wms = "https://geo.example.org/wms?layers=harita";
    expect(isWms(wms)).toBe(true);
    expect(validLayerUrl(wms)).toBeNull();
    expect(validLayerUrl("https://geo.example.org/wms?service=WMS")).not.toBeNull();
    const t = tileUrl(wms);
    expect(t).toContain("request=GetMap");
    expect(t).toContain("bbox={bbox-epsg-3857}");
    expect(t.startsWith("https://geo.example.org/wms?layers=harita&")).toBe(true);
    expect(tileUrl("https://{s}.tile.example/{z}/{x}/{y}.png")).toBe("https://a.tile.example/{z}/{x}/{y}.png");
  });
});
