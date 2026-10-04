import { describe, expect, it } from "vitest";
import { deviation } from "./deviation";

describe("deviation", () => {
  it("measures how far a track strays from a plan", () => {
    // Plan: doğu yönünde düz çizgi (enlem 41). Gerçek: ortada 1 km kuzeye sapıyor.
    const plan: [number, number][] = Array.from({ length: 11 }, (_, i) => [29 + i * 0.01, 41]);
    const real: [number, number][] = Array.from({ length: 101 }, (_, i) => {
      const lon = 29 + i * 0.001;
      const off = i >= 40 && i <= 60 ? 0.009 : 0;
      return [lon, 41 + off];
    });
    const d = deviation(plan, real, 200);
    expect(Math.round(d.maxM / 100)).toBe(10);
    expect(d.sections.length).toBe(1);
    expect(d.offShare).toBeGreaterThan(0.1);
    expect(d.offShare).toBeLessThan(0.4);
    expect(deviation(plan, plan, 200).maxM).toBeLessThan(1);
  });
});
