import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import { homeAt, lifePeriods } from "./lifePeriods";

const DAY = 86_400_000;
const rec = (t: number, start: [number, number], place: string) =>
  ({ path: `${t}`, timeZone: "UTC", start, startPlace: place, stats: { startTime: t } }) as unknown as FileSummary;

/** `from` gününden `days` gün boyunca her gün o yerden başlayan bir kayıt. */
const daily = (from: string, days: number, at: [number, number], place: string) =>
  Array.from({ length: days }, (_, i) => rec(Date.parse(`${from}T08:00:00Z`) + i * DAY, at, place));

describe("yaşam dönemleri", () => {
  it("ev değişikliğini dönemlere ayırır; kısa gezi dönemi bölmez", () => {
    const kadikoy: [number, number] = [29.03, 40.99];
    const atasehir: [number, number] = [29.12, 40.99];
    const list = [
      ...daily("2020-01-01", 120, kadikoy, "Kadıköy"),
      // Mayıs: gezide (her gün başka şehir) — dönem sürer.
      ...Array.from({ length: 10 }, (_, i) => rec(Date.parse("2020-05-01T08:00:00Z") + i * DAY, [27 + i, 37], `Yer ${i}`)),
      ...daily("2020-06-01", 60, kadikoy, "Kadıköy"),
      ...daily("2020-09-01", 150, atasehir, "Ataşehir"),
    ];
    const p = lifePeriods(list);
    expect(p.map((x) => [x.from, x.to, x.place])).toEqual([
      ["2020-01", "2020-07", "Kadıköy"],
      ["2020-09", "2021-01", "Ataşehir"],
    ]);
    expect(homeAt(p, Date.parse("2020-05-10"))).toEqual([29.03, 40.99].map((v) => expect.closeTo(v, 5)));
    expect(homeAt(p, Date.parse("2022-01-01"))![0]).toBeCloseTo(29.12, 5);
  });
  it("az veri: dönem yok", () => {
    expect(lifePeriods(daily("2020-01-01", 3, [29, 41], "X"))).toEqual([]);
  });
});
