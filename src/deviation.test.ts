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

  it("finds the nearest segment at high latitudes", () => {
    // 65°K: doğu-batı hücreleri kuzey-güneyin yarısından kısa; sonuç kaba aramayla aynı olmalı.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const plan: [number, number][] = Array.from({ length: 12 }, () => [20 + rnd() * 0.6, 65 + rnd() * 0.3]);
    const real: [number, number][] = Array.from({ length: 200 }, () => [20 + rnd() * 0.6, 65 + rnd() * 0.3]);
    const k = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
    const seg = (p: [number, number], a: [number, number], b: [number, number]) => {
      const [ax, ay, bx, by] = [(a[0] - p[0]) * k(p[1]), (a[1] - p[1]) * 110_574, (b[0] - p[0]) * k(p[1]), (b[1] - p[1]) * 110_574];
      const [dx, dy] = [bx - ax, by - ay];
      const len = dx * dx + dy * dy;
      const t = len > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len)) : 0;
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    for (const p of real) {
      let best = Infinity;
      for (let i = 1; i < plan.length; i++) best = Math.min(best, seg(p, plan[i - 1], plan[i]));
      expect(deviation(plan, [p], 1e9).maxM).toBeCloseTo(best, 0);
    }
  });
});
