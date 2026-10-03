import { describe, expect, it } from "vitest";
import { findOverlaps } from "./overlaps";
import { summary } from "./testing";

const H = 3_600_000;
const T = Date.parse("2024-06-01T10:00:00Z");

const rec = (path: string, start: number, end: number, hours?: number[]) =>
  summary(path, {
    stats: { startTime: start, endTime: end },
    hours: hours?.map((h) => [h, 0, 0] as [number, number, number]),
  });

describe("findOverlaps", () => {
  it("en az 30 dakika ortak süre çakışmadır", () => {
    const a = rec("a", T, T + 2 * H);
    const b = rec("b", T + H, T + 3 * H);
    // b ile yalnızca 10 dk ortak.
    const c = rec("c", T + 3 * H - 10 * 60_000, T + 4 * H);
    const m = findOverlaps([c, b, a]);
    expect(m.get("a")).toEqual([{ path: "b", ms: H }]);
    expect(m.get("b")).toEqual([{ path: "a", ms: H }]);
    expect(m.has("c")).toBe(false);
  });

  it("çakışanlar ortak süreye göre çoktan aza sıralanır", () => {
    const a = rec("a", T, T + 4 * H);
    const b = rec("b", T, T + H);
    const c = rec("c", T + H, T + 4 * H);
    expect(findOverlaps([a, b, c]).get("a")).toEqual([
      { path: "c", ms: 3 * H },
      { path: "b", ms: H },
    ]);
  });

  it("saatlik döküm varsa yalnızca ikisinin de verisi olan saatler sayılır", () => {
    // Uzun kayıtlar aynı aralıkta ama farklı saatlerde veri.
    const a = rec("a", T, T + 10 * H, [T, T + H]);
    const b = rec("b", T, T + 10 * H, [T + 5 * H, T + 6 * H]);
    expect(findOverlaps([a, b]).size).toBe(0);
    const c = rec("c", T + 30 * 60_000, T + 10 * H, [T, T + 5 * H]);
    expect(findOverlaps([a, c]).get("a")).toEqual([{ path: "c", ms: 30 * 60_000 }]);
  });

  it("zamansız, sıfır süreli ve aynı yoldaki kayıtlar atlanır", () => {
    const a = rec("a", T, T + 2 * H);
    expect(findOverlaps([a, summary("x"), rec("z", T, T), rec("a", T, T + 2 * H)]).size).toBe(0);
  });
});
