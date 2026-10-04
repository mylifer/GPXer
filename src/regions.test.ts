import { describe, expect, it } from "vitest";
import raw from "./assets/geo/tr-iller.geojson?raw";
import type { FileSummary } from "./api";
import { provincesOf, visitedProvinces, type ProvinceFC } from "./regions";

const fc = JSON.parse(raw) as ProvinceFC;

const trip = (lines: [number, number][][], start: number) =>
  ({
    path: "x",
    timeZone: "Europe/Istanbul",
    lines,
    times: lines.map((l) => l.map((_, i) => start + i * 3_600_000)),
    stats: { startTime: start },
  }) as unknown as FileSummary;

describe("provinces", () => {
  it("finds provinces along a route with first entry time", () => {
    // İstanbul (Kadıköy) → Kocaeli (İzmit) → Ankara (Kızılay) → Antalya kıyısı açığı (deniz).
    const t = Date.UTC(2023, 4, 1, 6);
    const s = trip([[[29.03, 40.99], [29.92, 40.77], [32.85, 39.92], [30.7, 36.5]]], t);
    const v = provincesOf(s, fc);
    expect([...v.keys()]).toEqual(["İstanbul", "Kocaeli", "Ankara"]);
    expect(v.get("Ankara")).toBe(t + 2 * 3_600_000);
    const list = visitedProvinces([s], fc, "", "");
    expect(list.map((p) => p.name)).toEqual(["İstanbul", "Kocaeli", "Ankara"]);
    expect(list[0].first).toBe("2023-05-01");
    expect(visitedProvinces([s], fc, "2024-01-01", "")).toEqual([]);
  });
});
