import { describe, expect, it } from "vitest";
import { maskLines, privacyZones } from "./privacy";

describe("privacy zones", () => {
  it("cuts lines inside private places only", () => {
    const zones = privacyZones([
      { id: "ev", name: "Ev", lat: 41, lon: 29.005, radiusM: 100, private: true },
      { id: "is", name: "İş", lat: 41, lon: 29.0, radiusM: 100 },
    ]);
    expect(zones).toEqual([{ center: [29.005, 41], radiusM: 300 }]);
    const line: [number, number][] = Array.from({ length: 11 }, (_, k) => [29 + k * 0.001, 41]);
    const out = maskLines([line], zones);
    expect(out.length).toBe(2);
    // 300 m ≈ 3,5 nokta (0,001° boylam ≈ 84 m): ortadaki 7 nokta atılır.
    expect(out.flat().length).toBe(11 - 7);
  });
});
