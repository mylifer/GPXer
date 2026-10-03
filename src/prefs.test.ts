import { describe, expect, it } from "vitest";
import { sanitizePrefs } from "./prefs";

describe("sanitizePrefs", () => {
  it("falls back to defaults for missing or broken data", () => {
    expect(sanitizePrefs(null)).toEqual(sanitizePrefs({}));
    expect(sanitizePrefs("x").filters.sort).toBe("date-desc");
  });

  it("keeps valid values and replaces invalid ones field by field", () => {
    const p = sanitizePrefs({
      filters: { sort: "bogus", query: 5, tag: "iş", area: [1, 2, 3] },
      hidden: null,
      colors: { a: "#fff", b: 3 },
      series: ["ele", "nope", "hr"],
      selected: "/a.gpx",
      mapView: { center: [29, 41], zoom: 8 },
      panelHeight: "300",
      tzMode: "record",
      trackColorBy: "speed",
    });
    expect(p.filters.sort).toBe("date-desc");
    expect(p.filters.query).toBe("");
    expect(p.filters.tag).toBe("iş");
    expect(p.filters.area).toBeNull();
    expect(p.hidden).toEqual([]);
    expect(p.colors).toEqual({ a: "#fff" });
    expect(p.series).toEqual(["ele", "hr"]);
    expect(p.selected).toBe("/a.gpx");
    expect(p.mapView).toEqual({ center: [29, 41], zoom: 8 });
    expect(p.panelHeight).toBe(340);
    expect(p.tzMode).toBe("record");
    expect(p.trackColorBy).toBe("speed");
  });
});
