/**
 * Fotoğrafları haritaya yerleştirme: konum bilgisi (GPS) olan fotoğraf olduğu
 * yerde; olmayan, çekim zamanını kapsayan kaydın izinde o ana en yakın konumda
 * gösterilir. Saat dilimsiz EXIF saati eşleşen kaydın saat dilimine göre çevrilir.
 */

import type { FileSummary, PhotoInfo } from "./api";
import { wallToUtc } from "./format";

const HOUR = 3_600_000;
/** Kaydın başından önce / sonundan sonra en fazla bu kadar uzaktaki fotoğraf eşleşir. */
const EDGE_MS = 15 * 60_000;
/** Bu uzunluktan kısa aralıklarda iki nokta arasında ara değer alınır. */
const INTERP_MS = HOUR;
/** Daha uzun aralıklarda en yakın noktaya en fazla bu kadar uzaksa yerleşir. */
const NEAR_MS = 30 * 60_000;
/** Saat dilimi farkı en fazla 14 saat: duvar saatiyle aday kayıt araması. */
const TZ_SLACK = 14 * HOUR;

export const IMAGE_EXTS = ["jpg", "jpeg", "heic", "heif", "png", "tif", "tiff", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "webp"];
export const isImagePath = (p: string) => IMAGE_EXTS.includes((p.split(".").pop() ?? "").toLowerCase());

export interface PlacedPhoto extends PhotoInfo {
  lon: number;
  lat: number;
  /** Gerçek çekim anı (düzeltme uygulanmış); bilinmiyorsa null. */
  at: number | null;
  /** Zamanı kapsayan kayıt. */
  record: string | null;
  /** Konum izden mi bulundu (GPS'siz fotoğraf). */
  fromTrack: boolean;
}

/** Kaydın `t` anındaki konumu (özetteki sadeleştirilmiş iz üzerinden). */
export function positionAt(s: FileSummary, t: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDt = Infinity;
  for (let li = 0; li < s.lines.length; li++) {
    const line = s.lines[li];
    const times = s.times[li];
    if (!times?.length) continue;
    const n = Math.min(line.length, times.length);
    // Zamanlar artan sırada kabul edilir; zamansız noktalar atlanır.
    let a = 0;
    let b = n;
    while (a < b) {
      const m = (a + b) >> 1;
      const tm = times[m];
      if (tm != null && tm <= t) a = m + 1;
      else if (tm == null) {
        // Zamansız noktada doğrusal aramaya düş.
        a = -1;
        break;
      } else b = m;
    }
    if (a < 0) {
      for (let i = 0; i < n; i++) {
        const ti = times[i];
        if (ti != null && Math.abs(ti - t) < bestDt) {
          bestDt = Math.abs(ti - t);
          best = line[i];
        }
      }
      continue;
    }
    const i = a - 1; // times[i] <= t < times[i+1]
    const ta = i >= 0 ? times[i] : null;
    const tb = i + 1 < n ? times[i + 1] : null;
    if (ta != null && tb != null && tb - ta <= INTERP_MS && tb > ta) {
      const r = (t - ta) / (tb - ta);
      const p = line[i];
      const q = line[i + 1];
      return [p[0] + (q[0] - p[0]) * r, p[1] + (q[1] - p[1]) * r];
    }
    if (ta != null && t - ta < bestDt) {
      bestDt = t - ta;
      best = line[i];
    }
    if (tb != null && tb - t < bestDt) {
      bestDt = tb - t;
      best = line[i + 1];
    }
  }
  return bestDt <= NEAR_MS ? best : null;
}

const covers = (s: FileSummary, t: number) =>
  s.stats.startTime! - EDGE_MS <= t && t <= s.stats.endTime! + EDGE_MS;

/** Fotoğrafları yerleştirir; yerleştirilemeyenler sayılır. `offsetH`: fotoğraf
 * makinesinin saat hatası (saat); çekim zamanına eklenir. */
export function placePhotos(
  photos: readonly PhotoInfo[],
  summaries: readonly FileSummary[],
  offsetH: number,
): { placed: PlacedPhoto[]; unplaced: number } {
  const timed = summaries
    .filter((s) => s.stats.startTime != null && s.stats.endTime != null && s.times.length)
    .sort((a, b) => a.stats.startTime! - b.stats.startTime!);
  const starts = timed.map((s) => s.stats.startTime!);
  // Uzun kayıtlar ikili aramayı bozmasın: başlangıçtan önceki en uzun süre.
  const maxSpan = timed.reduce((m, s) => Math.max(m, s.stats.endTime! - s.stats.startTime!), 0);
  /** Başlangıcı [lo - maxSpan - EDGE, hi + EDGE] aralığında olan kayıtlar. */
  const candidates = (lo: number, hi: number) => {
    let a = 0;
    let b = starts.length;
    const hiT = hi + EDGE_MS;
    while (a < b) {
      const m = (a + b) >> 1;
      if (starts[m] <= hiT) a = m + 1;
      else b = m;
    }
    const out: FileSummary[] = [];
    for (let i = a - 1; i >= 0 && starts[i] >= lo - maxSpan - EDGE_MS; i--) out.push(timed[i]);
    return out;
  };
  const placed: PlacedPhoto[] = [];
  let unplaced = 0;
  const off = offsetH * HOUR;
  for (const p of photos) {
    let at: number | null = null;
    let record: FileSummary | null = null;
    if (p.time != null) {
      const t0 = p.time + off;
      if (p.timeIsLocal) {
        // Duvar saati: her aday kayıt kendi saat dilimiyle denenir.
        for (const s of candidates(t0 - TZ_SLACK, t0 + TZ_SLACK)) {
          const t = wallToUtc(t0, s.timeZone);
          if (covers(s, t) && (!record || s.stats.endTime! - s.stats.startTime! < record.stats.endTime! - record.stats.startTime!)) {
            record = s;
            at = t;
          }
        }
        if (at == null) at = wallToUtc(t0, null);
      } else {
        at = t0;
        for (const s of candidates(t0, t0)) {
          // Kapsayanlardan en kısası: uzun kayıt içindeki günlük kayıt daha ayrıntılı.
          if (covers(s, t0) && (!record || s.stats.endTime! - s.stats.startTime! < record.stats.endTime! - record.stats.startTime!)) record = s;
        }
      }
    }
    if (p.lat != null && p.lon != null) {
      placed.push({ ...p, lat: p.lat, lon: p.lon, at, record: record?.path ?? null, fromTrack: false });
      continue;
    }
    const pos = record && at != null ? positionAt(record, at) : null;
    if (!pos) {
      unplaced++;
      continue;
    }
    placed.push({ ...p, lon: pos[0], lat: pos[1], at, record: record!.path, fromTrack: true });
  }
  return { placed, unplaced };
}
