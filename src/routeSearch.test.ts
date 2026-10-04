import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { legsBetween } from "./routeSearch";

const M = 60_000;
const rec = (path: string, pts: [number, number][], t0: number) =>
  ({ path, lines: [pts], times: [pts.map((_, i) => t0 + i * 10 * M)] }) as unknown as FileSummary;

describe("legsBetween", () => {
  it("finds A→B trips in order, not B→A", () => {
    const A: [number, number] = [29, 41];
    const B: [number, number] = [29.5, 41];
    const there = rec("gidis", [[29, 41], [29.1, 41], [29.3, 41], [29.5, 41]], 1000);
    const back = rec("donus", [[29.5, 41], [29.3, 41], [29, 41]], 5000);
    // Gidip dönüş tek kayıtta: bir gidiş sayılır.
    const loop = rec("tur", [[29, 41], [29.25, 41], [29.5, 41], [29.25, 41], [29, 41]], 9000);
    const legs = legsBetween([there, back, loop], A, B, 1000);
    expect(legs.map((l) => l.path).sort()).toEqual(["gidis", "tur"]);
    const g = legs.find((l) => l.path === "gidis")!;
    expect(g.arrive - g.leave).toBe(30 * M);
    expect(Math.round(g.distanceM / 1000)).toBe(42);
    expect(legsBetween([there, back, loop], B, A, 1000).map((l) => l.path).sort()).toEqual(["donus", "tur"]);
  });
});
