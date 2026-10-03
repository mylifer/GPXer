import { describe, expect, it } from "vitest";
import type { Gap } from "./api";
import { flightsOf } from "./flights";
import { summary } from "./testing";

const H = 3_600_000;
const T = Date.parse("2024-06-01T08:00:00Z");

const gap = (km: number, ms: number, start: number | null = T): Gap => ({
  from: [29, 41],
  to: [30, 42],
  start,
  end: start == null ? null : start + ms,
  distanceM: km * 1000,
});

/** Boşluk uçuş sayılıyor mu (tek boşluklu kayıtla). */
const flies = (g: Gap) => flightsOf(summary(`p${Math.random()}`, { gaps: [g] })).length === 1;

describe("uçuş kuralları", () => {
  it("300 km/sa'i ve 100 km'yi aşan boşluk uçuştur", () => {
    expect(flies(gap(1000, 2 * H))).toBe(true);
  });

  it("100 km ve altı uçuş değildir (hızlı da olsa)", () => {
    expect(flies(gap(90, 10 * 60_000))).toBe(false);
    expect(flies(gap(100, 10 * 60_000))).toBe(false);
  });

  it("200 km'den uzak, 6 saatten kısa ve en az 150 km/sa ise uçuştur", () => {
    // 250 km, 1,5 sa: ~167 km/sa.
    expect(flies(gap(250, 1.5 * H))).toBe(true);
  });

  it("250 km / 5 sa araba yolculuğu (50 km/sa) uçuş değildir", () => {
    expect(flies(gap(250, 5 * H))).toBe(false);
  });

  it("6 saat ve üstü yavaş boşluk uçuş değildir", () => {
    expect(flies(gap(1000, 7 * H))).toBe(false);
  });

  it("süresiz, sıfır ya da geriye giden boşluk uçuş değildir", () => {
    expect(flies(gap(1000, 0))).toBe(false);
    expect(flies(gap(1000, -H))).toBe(false);
    expect(flies(gap(1000, H, null))).toBe(false);
  });

  it("uçuş bilgileri boşluktan alınır", () => {
    const s = summary("u", { gaps: [gap(10, H), gap(1000, 2 * H)] });
    const [f] = flightsOf(s);
    expect(f).toMatchObject({ path: "u", gap: 1, start: T, end: T + 2 * H, durationMs: 2 * H, distanceM: 1_000_000 });
    expect(flightsOf(s)).toBe(flightsOf(s));
  });
});
