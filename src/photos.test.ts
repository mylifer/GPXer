import { describe, expect, it } from "vitest";
import type { PhotoInfo } from "./api";
import { placePhotos } from "./photos";
import { straightLine, summary } from "./testing";

const H = 3_600_000;
// İstanbul'da 5 saatlik kayıt: 09:00–14:00 yerel (06:00–11:00Z), 10 dakikada bir nokta.
const START = Date.parse("2024-06-01T06:00:00Z");
const { lines, times } = straightLine([29, 41], [29.5, 41], 31, START, 10 * 60_000);
const record = summary("/k/ist.gpx", {
  timeZone: "Europe/Istanbul",
  lines,
  times,
  stats: { startTime: START, endTime: START + 5 * H },
});

const photo = (o: Partial<PhotoInfo>): PhotoInfo => ({
  path: "/f/a.jpg",
  name: "a.jpg",
  time: null,
  timeIsLocal: false,
  lat: null,
  lon: null,
  thumb: null,
  ...o,
});

describe("placePhotos", () => {
  it("saat dilimsiz yerel saatli fotoğraf kaydın diliminde yerleşir", () => {
    // 13:30 yerel = 10:30Z; duvar saati UTC'ymiş gibi kaydın bitişinden sonra.
    const p = photo({ time: Date.UTC(2024, 5, 1, 13, 30), timeIsLocal: true });
    const { placed, unplaced } = placePhotos([p], [record], 0);
    expect(unplaced).toBe(0);
    expect(placed).toHaveLength(1);
    const x = placed[0];
    expect(x.at).toBe(Date.parse("2024-06-01T10:30:00Z"));
    expect(x.record).toBe("/k/ist.gpx");
    expect(x.fromTrack).toBe(true);
    // 4,5 saat / 5 saat boyunca.
    expect(x.lon).toBeCloseTo(29 + 0.5 * 0.9, 6);
    expect(x.lat).toBeCloseTo(41, 6);
  });

  it("UTC zamanlı fotoğraf ve saat düzeltmesi", () => {
    const p = photo({ time: Date.parse("2024-06-01T07:00:00Z") });
    expect(placePhotos([p], [record], 0).placed[0].lon).toBeCloseTo(29.1, 6);
    // Makine saati 1 saat geri: +1 sa düzeltme.
    expect(placePhotos([p], [record], 1).placed[0].lon).toBeCloseTo(29.2, 6);
  });

  it("GPS'li fotoğraf kendi yerinde; kapsamayan zaman yerleşmez", () => {
    const gps = photo({ time: START, lat: 40, lon: 28 });
    const late = photo({ time: START + 6 * H });
    const none = photo({});
    const { placed, unplaced } = placePhotos([gps, late, none], [record], 0);
    expect(placed).toEqual([{ ...gps, lat: 40, lon: 28, at: START, record: "/k/ist.gpx", fromTrack: false }]);
    expect(unplaced).toBe(2);
  });
});
