import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { passesNear } from "./here";

const M = 60_000;
const rec = (path: string, pts: [number, number][], t0: number, stepMs = M) =>
  ({
    path,
    lines: [pts],
    times: [pts.map((_, i) => t0 + i * stepMs)],
    stats: {
      startTime: t0,
      bbox: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
    },
  }) as unknown as FileSummary;

describe("passes near a point", () => {
  const P: [number, number] = [29.078, 40.972];
  it("finds passes, splits returns after a long while, ignores far records", () => {
    // Doğu-batı yönünde noktanın 30 m kuzeyinden geçer; seyrek noktalar (aralarında nokta yok).
    const t0 = Date.UTC(2024, 6, 9, 6);
    const there = rec(
      "a",
      [
        [29.07, 40.97227],
        [29.09, 40.97227],
      ],
      t0,
      10 * M,
    );
    // Gidip 2 saat sonra aynı yerden dönen kayıt.
    const back = rec(
      "b",
      [
        [29.07, 40.9721],
        [29.078, 40.9721],
        [29.1, 40.98],
        [29.1, 40.98],
        [29.078, 40.9721],
        [29.07, 40.9721],
      ],
      t0 + 86_400_000,
      40 * M,
    );
    const far = rec(
      "c",
      [
        [29.2, 41.0],
        [29.3, 41.1],
      ],
      t0,
    );
    const r = passesNear([there, back, far], P[0], P[1], 150);
    expect(r.map((p) => p.path)).toEqual(["b", "b", "a"]);
    expect(r[2].distM).toBeLessThan(40);
    // Bölümün ortasına denk gelen an: başlangıçtan ~4 dk sonra.
    expect(Math.round((r[2].t! - t0) / M)).toBe(4);
    expect(passesNear([there], P[0], P[1], 20)).toEqual([]);
  });
});
