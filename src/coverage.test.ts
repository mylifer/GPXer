import { describe, expect, it } from "vitest";
import { coverage } from "./coverage";

describe("coverage", () => {
  it("ay doluluğu ve uzun boşluklar", () => {
    const c = coverage(["2024-01-01", "2024-01-02", "2024-01-02", "2024-03-01", "2025-02-10", "2025-02-12"], 14);
    expect(c.recorded).toBe(5);
    expect(c.years.map(([y]) => y)).toEqual([2025, 2024]);
    expect(c.years[1][1][0]).toEqual([2, 31]);
    expect(c.years[1][1][1]).toEqual([0, 29]);
    expect(c.years[0][1][1]).toEqual([2, 28]);
    expect(c.gaps).toEqual([
      { from: "2024-03-02", to: "2025-02-09", days: 345 },
      { from: "2024-01-03", to: "2024-02-29", days: 58 },
    ]);
    expect(c.span).toBe(409);
  });
  it("boş girdi", () => {
    expect(coverage([])).toEqual({ years: [], gaps: [], recorded: 0, span: 0 });
  });
});
