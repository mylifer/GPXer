import { afterEach, describe, expect, it } from "vitest";
import { dayBuckets, hourDays, rangePart, rangeShare, touchesRange } from "./days";
import { setTzMode } from "./format";
import { summary } from "./testing";

const H = 3_600_000;
const at = (iso: string) => Date.parse(iso);

afterEach(() => setTzMode("local"));

describe("dayBuckets", () => {
  it("saatlik dökümü günlere dağıtır", () => {
    // UTC: 1 Ocak 22:00 ve 23:00, 2 Ocak 00:00.
    const s = summary("a", {
      stats: { startTime: at("2024-01-01T22:00:00Z"), distanceM: 3000, movingMs: 3 * H },
      hours: [
        [at("2024-01-01T22:00:00Z"), 1000, H],
        [at("2024-01-01T23:00:00Z"), 1000, H],
        [at("2024-01-02T00:00:00Z"), 1000, H],
      ],
    });
    expect(dayBuckets(s)).toEqual([
      { day: "2024-01-01", distanceM: 2000, movingMs: 2 * H },
      { day: "2024-01-02", distanceM: 1000, movingMs: H },
    ]);
  });

  it("kaydın saat diliminde gün sınırı değişir", () => {
    setTzMode("record");
    const s = summary("b", {
      timeZone: "Europe/Istanbul",
      stats: { startTime: at("2024-01-01T22:00:00Z"), distanceM: 1000, movingMs: H },
      hours: [[at("2024-01-01T22:00:00Z"), 1000, H]],
    });
    // İstanbul'da 2 Ocak 01:00.
    expect(dayBuckets(s).map((d) => d.day)).toEqual(["2024-01-02"]);
  });

  it(":30 farklı dilimde gece yarısını aşan saat iki güne bölünür", () => {
    setTzMode("record");
    // Kolkata +05:30: 18:00Z = 23:30 yerel, saatin yarısı ertesi güne düşer.
    const h = at("2024-01-01T18:00:00Z");
    expect(hourDays(h, null, "Asia/Kolkata")).toEqual([
      ["2024-01-01", 0.5],
      ["2024-01-02", 0.5],
    ]);
    const s = summary("c", {
      timeZone: "Asia/Kolkata",
      stats: { startTime: h, distanceM: 1000, movingMs: H },
      hours: [[h, 1000, H]],
    });
    expect(dayBuckets(s)).toEqual([
      { day: "2024-01-01", distanceM: 500, movingMs: H / 2 },
      { day: "2024-01-02", distanceM: 500, movingMs: H / 2 },
    ]);
  });

  it("kayıt saat ortasında başlıyorsa pay başlangıçtan hesaplanır", () => {
    // 18:15Z başlangıç: yerel 23:45 → 00:30; 15 dk ilk güne, 30 dk ikinciye.
    const h = at("2024-01-01T18:00:00Z");
    const [[d0, f0], [d1, f1]] = hourDays(h, h + H / 4, "Asia/Kolkata");
    expect([d0, d1]).toEqual(["2024-01-01", "2024-01-02"]);
    expect(f0).toBeCloseTo(1 / 3);
    expect(f1).toBeCloseTo(2 / 3);
  });

  it("saatlik döküm yoksa tamamı başladığı güne yazılır; tarihsizse boş", () => {
    const s = summary("d", { stats: { startTime: at("2024-05-05T10:00:00Z"), distanceM: 5000, movingMs: H } });
    expect(dayBuckets(s)).toEqual([{ day: "2024-05-05", distanceM: 5000, movingMs: H }]);
    expect(dayBuckets(summary("e"))).toEqual([]);
  });
});

describe("touchesRange / rangePart", () => {
  // 1, 3 ve 5 Mart'ta kayıt.
  const s = summary("m", {
    stats: { startTime: at("2024-03-01T10:00:00Z"), distanceM: 6000, movingMs: 3 * H, elevationGainM: 60 },
    hours: [
      [at("2024-03-01T10:00:00Z"), 1000, H],
      [at("2024-03-03T10:00:00Z"), 2000, H],
      [at("2024-03-05T10:00:00Z"), 3000, H],
    ],
  });

  it("herhangi bir günü aralıktaysa dokunur", () => {
    expect(touchesRange(s, "", "")).toBe(true);
    expect(touchesRange(s, "2024-03-03", "2024-03-03")).toBe(true);
    expect(touchesRange(s, "2024-03-05", "")).toBe(true);
    expect(touchesRange(s, "", "2024-03-01")).toBe(true);
    // Kaydın içinde ama verisi olmayan gün.
    expect(touchesRange(s, "2024-03-02", "2024-03-02")).toBe(false);
    expect(touchesRange(s, "2024-03-06", "")).toBe(false);
    expect(touchesRange(s, "", "2024-02-29")).toBe(false);
    expect(touchesRange(summary("x"), "", "")).toBe(false);
  });

  it("aralığa düşen günlerin toplamı", () => {
    expect(rangePart(s, "2024-03-02", "2024-03-05")).toEqual({ distanceM: 5000, movingMs: 2 * H, days: 2 });
    expect(rangePart(s, "2024-03-06", "")).toEqual({ distanceM: 0, movingMs: 0, days: 0 });
  });

  it("pay: tırmanış mesafe oranında, tamamı aralıktaysa kendi değerleri", () => {
    expect(rangeShare(s, "2024-03-05", "")).toEqual({ distanceM: 3000, movingMs: H, gainM: 30, partial: true });
    expect(rangeShare(s, "2024-03-01", "2024-03-05")).toEqual({ distanceM: 6000, movingMs: 3 * H, gainM: 60, partial: false });
  });
});

describe("dedupedDays", () => {
  it("counts copies of the same trip once, separate activities fully", async () => {
    const { dedupedTotals } = await import("./days");
    const H = 3_600_000;
    const t0 = Date.UTC(2024, 5, 4, 8);
    const rec = (start: number, hours: [number, number, number][], dist: number) =>
      ({
        path: String(start) + dist,
        timeZone: "UTC",
        hours,
        stats: { startTime: start, distanceM: dist, movingMs: hours.length * H, elevationGainM: 100 },
      }) as unknown as import("./api").FileSummary;
    const trip = rec(t0, [[t0, 10_000, H], [t0 + H, 20_000, H]], 30_000);
    const copy = rec(t0, [[t0, 10_000, H], [t0 + H, 20_000, H]], 30_000);
    // Konum geçmişi aynı saatlerde daha az mesafe görüyor.
    const history = rec(t0 - 5 * H, [[t0 - 5 * H, 1_000, H], [t0, 8_000, H], [t0 + H, 15_000, H]], 24_000);
    // Aynı gün akşam ayrı bir yürüyüş.
    const walk = rec(t0 + 10 * H, [[t0 + 10 * H, 3_000, H]], 3_000);
    const t = dedupedTotals([trip, copy, history, walk], "", "");
    expect(t.distanceM).toBe(30_000 + 1_000 + 3_000);
    expect(t.gainM).toBeCloseTo(100 + 100 * (1_000 / 24_000) + 100);
  });
});
