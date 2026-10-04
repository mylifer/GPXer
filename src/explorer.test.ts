import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { explorerStats } from "./explorer";

const rec = (lines: [number, number][][]) => ({ lines, times: lines.map(() => []) }) as unknown as FileSummary;

describe("explorer tiles", () => {
  it("fills tiles between points and finds the largest square", () => {
    // ~0,022° ≈ bir kare (z14); 3 yatay çizgi 3×3'lük bir blok kaplar.
    const d = 360 / 2 ** 14;
    const row = (lat: number): [number, number][] => [
      [29 + d * 0.5, lat],
      [29 + d * 2.5, lat],
    ];
    const s = rec([row(41.0), row(41.0 - d * 0.75), row(41.0 - d * 1.5)]);
    const st = explorerStats([s]);
    expect(st.tiles.size).toBeGreaterThanOrEqual(9);
    expect(st.maxSquare).toBe(3);
  });
});
