import { describe, expect, it } from "vitest";
import raw from "./assets/geo/tr-iller.geojson?raw";
import worldRaw from "./assets/geo/bolgeler.geojson?raw";
import type { FileSummary } from "./api";
import { provincesOf, regionCounts, visitedProvinces, type ProvinceFC } from "./regions";

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
    const s = trip(
      [
        [
          [29.03, 40.99],
          [29.92, 40.77],
          [32.85, 39.92],
          [30.7, 36.5],
        ],
      ],
      t,
    );
    const v = provincesOf(s, fc);
    expect([...v.keys()]).toEqual(["İstanbul", "Kocaeli", "Ankara"]);
    expect(v.get("Ankara")).toBe(t + 2 * 3_600_000);
    const list = visitedProvinces([s], fc, "", "");
    expect(list.map((p) => p.name)).toEqual(["İstanbul", "Kocaeli", "Ankara"]);
    expect(list[0].first).toBe("2023-05-01");
    expect(visitedProvinces([s], fc, "2024-01-01", "")).toEqual([]);
  });

  it("counts a province crossed inside the date range even if entered before it", () => {
    // 1 Mayıs İstanbul'da başlayan kayıt, 2 Mayıs'ta hâlâ İstanbul'da, sonra Ankara.
    const t = Date.UTC(2023, 4, 1, 6);
    const day = 86_400_000;
    const s = {
      path: "y",
      timeZone: "Europe/Istanbul",
      lines: [
        [
          [29.03, 40.99],
          [29.04, 40.99],
          [32.85, 39.92],
        ],
      ],
      times: [[t, t + day, t + day + 3 * 3_600_000]],
      stats: { startTime: t },
    } as unknown as FileSummary;
    const list = visitedProvinces([s], fc, "2023-05-02", "");
    expect(list.map((p) => [p.name, p.first])).toEqual([
      ["İstanbul", "2023-05-02"],
      ["Ankara", "2023-05-02"],
    ]);
    expect(provincesOf(s, fc).get("İstanbul")).toBe(t);
  });

  it("finds first-level regions abroad together with Turkish provinces", () => {
    const world = { type: "FeatureCollection", features: [...fc.features, ...(JSON.parse(worldRaw) as ProvinceFC).features] } as ProvinceFC;
    // Edirne → Bulgaristan (Plovdiv) → Yunanistan (Selanik) → Almanya (Münih).
    const t = Date.UTC(2023, 6, 1, 6);
    const s = trip(
      [
        [
          [26.56, 41.68],
          [24.75, 42.15],
          [22.94, 40.64],
          [11.58, 48.14],
        ],
      ],
      t,
    );
    const list = visitedProvinces([s], world, "", "");
    expect(list.map((p) => [p.cc, p.name])).toEqual([
      ["TR", "Edirne"],
      ["BG", "Filibe"],
      ["GR", "Orta Makedonya"],
      ["DE", "Bavyera"],
    ]);
    const n = regionCounts(world);
    expect(n.get("TR")).toBe(81);
    expect(n.get("DE")).toBe(16);
    expect(n.get("US")).toBe(51);
  });
});
