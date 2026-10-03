import { describe, expect, it } from "vitest";
import { findRoutes } from "./routes";
import { straightLine, summary } from "./testing";

const T = Date.parse("2024-06-01T07:00:00Z");
const DAY = 86_400_000;

/** ~2,2 km kuzeye giden kayıt; `dLon` ile doğuya kaydırılır. */
const commute = (path: string, day: number, dLon = 0, reverse = false) => {
  const a: [number, number] = [29 + dLon, 41];
  const b: [number, number] = [29 + dLon, 41.02];
  const { lines } = straightLine(reverse ? b : a, reverse ? a : b, 30);
  return summary(path, { lines, stats: { distanceM: 2224, startTime: T + day * DAY } });
};

describe("findRoutes", () => {
  it("başı, sonu ve izi yakın kayıtları aynı güzergâhta toplar", () => {
    const list = [
      commute("c", 2, 0.0005), // ~42 m doğuda
      commute("a", 0),
      commute("b", 1, -0.0005),
      commute("ters", 3, 0, true),
      commute("uzak", 4, 0.01), // ~840 m doğuda
      summary("kısa", { lines: [[[29, 41], [29, 41.001]]], stats: { distanceM: 111 } }),
    ];
    const { routes, byPath } = findRoutes(list);
    expect(routes).toEqual([{ id: "a", paths: ["a", "b", "c"] }]);
    expect(byPath.get("c")).toBe(routes[0]);
    expect(byPath.has("ters")).toBe(false);
    expect(byPath.has("uzak")).toBe(false);
    expect(byPath.has("kısa")).toBe(false);
  });

  it("mesafesi çok farklı kayıt ayrı kalır; tek kayıt güzergâh değildir", () => {
    const a = commute("a", 0);
    const b = { ...commute("b", 1), stats: { ...commute("b", 1).stats, distanceM: 3000 } };
    expect(findRoutes([a, b]).routes).toEqual([]);
    expect(findRoutes([a]).routes).toEqual([]);
  });

  it("kalabalık güzergâh önce gelir", () => {
    const list = [
      commute("x1", 0, 0.05),
      commute("x2", 1, 0.05),
      commute("a1", 2),
      commute("a2", 3),
      commute("a3", 4),
    ];
    expect(findRoutes(list).routes.map((r) => r.paths)).toEqual([
      ["a1", "a2", "a3"],
      ["x1", "x2"],
    ]);
  });
});
