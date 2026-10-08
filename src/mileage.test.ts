import { describe, expect, it } from "vitest";
import type { FileMeta, FileSummary } from "./api";
import { mileageCsv, mileageLog } from "./mileage";
import type { FileEntry } from "./types";

const rec = (path: string, start: string, km: number, place: string): FileEntry =>
  ({
    color: "#000",
    summary: {
      path,
      fileName: `${path}.gpx`,
      name: path,
      timeZone: "UTC",
      startPlace: "Kadıköy",
      endPlace: place,
      hours: [],
      stats: { startTime: Date.parse(start), distanceM: km * 1000 },
    } as unknown as FileSummary,
  }) as FileEntry;

const m = (tags: string[], note = ""): FileMeta => ({ tags, note, activity: null });

describe("kilometre defteri", () => {
  it("etiketli kayıtlar, aylık toplamlar ve yakıt", () => {
    const files = [rec("a", "2024-03-05T08:00:00Z", 120, "İzmit"), rec("b", "2024-03-20T08:00:00Z", 30, "Ataşehir"), rec("c", "2024-05-01T08:00:00Z", 100, "Bursa"), rec("d", "2024-05-02T08:00:00Z", 50, "Ev"), rec("e", "2023-12-01T08:00:00Z", 10, "X")];
    const meta = { a: m(["İş"], "Müşteri; toplantı"), b: m(["iş"]), c: m(["iş", "tatil"]), d: m(["tatil"]), e: m(["iş"]) };
    const log = mileageLog(files, meta, "iş", "2024", { kind: "benzin", per100: 8, price: 50 });
    expect(log.trips.map((t) => t.path)).toEqual(["a", "b", "c"]);
    expect(log.months).toEqual([
      { month: "2024-03", trips: 2, km: 150, cost: 600 },
      { month: "2024-05", trips: 1, km: 100, cost: 400 },
    ]);
    expect(log.km).toBe(250);
    const csv = mileageCsv(log);
    expect(csv.startsWith("﻿Tarih;Kayıt;Güzergâh;Km;Yakıt (₺);Not")).toBe(true);
    expect(csv).toContain('05.03.2024;a;Kadıköy → İzmit;120,0;480;"Müşteri; toplantı"');
    expect(csv).toContain("Toplam;3;;250,0;1000;");
  });
});
