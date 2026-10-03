import { describe, expect, it } from "vitest";
import { dayKey, fastDayKey, fmtDistance, fmtPace, parseTrWall, wallToUtc } from "./format";

const wall = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const H = 3_600_000;

describe("wallToUtc", () => {
  it("sabit farklı dilim", () => {
    expect(wallToUtc(wall(2024, 6, 1, 12), "Europe/Istanbul")).toBe(Date.parse("2024-06-01T09:00:00Z"));
    expect(wallToUtc(wall(2024, 6, 1, 12), "Asia/Kolkata")).toBe(Date.parse("2024-06-01T06:30:00Z"));
  });

  it("yaz ve kış saatinde farklı fark", () => {
    expect(wallToUtc(wall(2024, 1, 15, 12), "Europe/Berlin")).toBe(Date.parse("2024-01-15T11:00:00Z"));
    expect(wallToUtc(wall(2024, 7, 15, 12), "Europe/Berlin")).toBe(Date.parse("2024-07-15T10:00:00Z"));
    expect(wallToUtc(wall(2024, 7, 15, 12), "America/New_York")).toBe(Date.parse("2024-07-15T16:00:00Z"));
  });

  it("ileri alma: var olmayan duvar saati bir saat ileri kayar", () => {
    // Berlin 31.03.2024 02:00 → 03:00; 02:30 yok.
    expect(wallToUtc(wall(2024, 3, 31, 1, 30), "Europe/Berlin")).toBe(Date.parse("2024-03-31T00:30:00Z"));
    expect(wallToUtc(wall(2024, 3, 31, 2, 30), "Europe/Berlin")).toBe(Date.parse("2024-03-31T01:30:00Z"));
    expect(wallToUtc(wall(2024, 3, 31, 3, 30), "Europe/Berlin")).toBe(Date.parse("2024-03-31T01:30:00Z"));
  });

  it("geri alma: iki kez yaşanan duvar saati iki geçerli andan birine düşer", () => {
    // Berlin 27.10.2024 03:00 → 02:00; 02:30 hem 00:30Z hem 01:30Z.
    const t = wallToUtc(wall(2024, 10, 27, 2, 30), "Europe/Berlin");
    expect([Date.parse("2024-10-27T00:30:00Z"), Date.parse("2024-10-27T01:30:00Z")]).toContain(t);
    expect(wallToUtc(wall(2024, 10, 27, 1, 30), "Europe/Berlin")).toBe(Date.parse("2024-10-26T23:30:00Z"));
    expect(wallToUtc(wall(2024, 10, 27, 3, 30), "Europe/Berlin")).toBe(Date.parse("2024-10-27T02:30:00Z"));
  });

  it("dilim verilmezse bilgisayarınki (testlerde UTC)", () => {
    expect(wallToUtc(wall(2024, 6, 1, 12), null)).toBe(wall(2024, 6, 1, 12));
  });
});

describe("parseTrWall", () => {
  it("gg.aa.yyyy ve ss:dd okur", () => {
    expect(parseTrWall("31.03.2024", "02:30")).toBe(wall(2024, 3, 31, 2, 30));
    expect(parseTrWall("1/2/2024", "9.05")).toBe(wall(2024, 2, 1, 9, 5));
    expect(parseTrWall("01-02-2024", "")).toBe(wall(2024, 2, 1));
  });

  it("geçersiz tarih ya da saat null", () => {
    expect(parseTrWall("30.02.2024", "10:00")).toBeNull();
    expect(parseTrWall("2024-02-01", "10:00")).toBeNull();
    expect(parseTrWall("01.02.2024", "24:00")).toBeNull();
    expect(parseTrWall("01.02.2024", "10:60")).toBeNull();
    expect(parseTrWall("01.02.2024", "10")).toBeNull();
  });
});

describe("dayKey / fastDayKey", () => {
  it("aynı günü verir", () => {
    const start = Date.parse("2024-03-30T20:00:00Z");
    for (const tz of [undefined, "Europe/Istanbul", "Asia/Kolkata", "Asia/Kathmandu", "America/St_Johns", "Europe/Berlin"]) {
      for (let t = start; t < start + 2 * 24 * H; t += 7 * 60_000) expect(fastDayKey(t, tz)).toBe(dayKey(t, tz));
    }
  });

  it("yyyy-aa-gg biçimi", () => {
    expect(dayKey(Date.parse("2024-01-01T22:30:00Z"), "Europe/Istanbul")).toBe("2024-01-02");
    expect(dayKey(Date.parse("2024-01-01T22:30:00Z"))).toBe("2024-01-01");
  });
});

describe("rounding edges", () => {
  it("never shows :60 in a pace or 1.000 m", () => {
    expect(fmtPace(1000 / 299.6)).toBe("5:00 /km");
    expect(fmtPace(1000 / 359.7)).toBe("6:00 /km");
    expect(fmtDistance(999.6)).toBe("1,00 km");
    expect(fmtDistance(999.4)).toBe("999 m");
  });
});
