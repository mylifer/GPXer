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

  it("uçarken alınan noktayla bölünen uçuş tek uçuş sayılır", () => {
    // İstanbul → (inişte bir nokta) → Köln: 1678 km + 117 km, arada 4 dk.
    const a: Gap = { from: [29.3, 40.9], to: [12.2, 50.2], start: T, end: T + 125 * 60_000, distanceM: 1_678_000 };
    const b: Gap = {
      from: [11.6, 50.3],
      to: [8.0, 50.97],
      start: T + 129 * 60_000,
      end: T + 136 * 60_000,
      distanceM: 117_000,
    };
    const fl = flightsOf(summary("m", { gaps: [a, b] }));
    expect(fl).toHaveLength(1);
    expect(fl[0]).toMatchObject({ from: a.from, to: b.to, start: a.start, end: b.end, gap: 0 });
    expect(fl[0].distanceM).toBeGreaterThan(1_678_000 + 117_000);
  });

  it("yerde bekleyip sonra uçulan ikinci boşluk ayrı uçuştur", () => {
    const a: Gap = { from: [29.3, 40.9], to: [12.2, 50.2], start: T, end: T + 2 * H, distanceM: 1_678_000 };
    const b: Gap = { from: [12.2, 50.2], to: [2.3, 48.8], start: T + 5 * H, end: T + 6.5 * H, distanceM: 800_000 };
    expect(flightsOf(summary("n", { gaps: [a, b] }))).toHaveLength(2);
  });

  it("uç adları boşluğun uçlarındaki yerlerden alınır", () => {
    const g: Gap = { ...gap(1000, 2 * H), fromPlace: "Pendik", toPlace: "Wahn-Heide" };
    const [f] = flightsOf(summary("adlar", { gaps: [g] }));
    expect([f.fromName, f.toName]).toEqual(["Pendik", "Wahn-Heide"]);
  });

  it("ses hızını aşan sıçrama (GPS hatası, bozuk saat) uçuş değildir", () => {
    // 2 dakikada 10.417 km (Pasifik'e sıçrama) ve 1 saniyede 2.032 km.
    expect(flies(gap(10_417, 2 * 60_000))).toBe(false);
    expect(flies(gap(2_032, 1000))).toBe(false);
    // Hızlı ama gerçekçi uçuş (1.100 km/sa) uçuştur.
    expect(flies(gap(2_200, 2 * H))).toBe(true);
  });
});
