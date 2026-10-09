import { t } from "./i18n";
/** "Geçmiş yıllarda bugün": bugünün ay ve gününde önceki yıllarda yapılmış
 * kayıtlar (çok günlük kayıtlarda o güne düşen bölüm de sayılır). */
import { dayBuckets } from "./days";
import { fmtDistance } from "./format";
import type { FileEntry } from "./types";

export interface Memory {
  /** Kaç yıl önce. */
  years: number;
  /** yyyy-aa-gg */
  day: string;
  entries: FileEntry[];
  /** O günün toplam mesafesi (m). */
  distanceM: number;
}

/** `today`: yyyy-aa-gg (yerel). En yakın yıl önce. */
export function onThisDay(files: FileEntry[], today: string): Memory[] {
  const md = today.slice(5);
  const year = Number(today.slice(0, 4));
  const byDay = new Map<string, Memory>();
  for (const f of files) {
    for (const b of dayBuckets(f.summary)) {
      if (b.day.slice(5) !== md) continue;
      const y = Number(b.day.slice(0, 4));
      if (y >= year) continue;
      let m = byDay.get(b.day);
      if (!m) byDay.set(b.day, (m = { years: year - y, day: b.day, entries: [], distanceM: 0 }));
      if (!m.entries.includes(f)) m.entries.push(f);
      m.distanceM += b.distanceM;
    }
  }
  return [...byDay.values()].sort((a, b) => a.years - b.years);
}

/** Kısa açıklama: "Bodrum → Marmaris · 160 km" ya da "3 kayıt · 210 km". */
export function memoryText(m: Memory): string {
  const s = m.entries.map((e) => e.summary).sort((a, b) => (a.stats.startTime ?? 0) - (b.stats.startTime ?? 0));
  const from = s[0].startPlace;
  const to = s[s.length - 1].endPlace;
  const where = from && to && from !== to ? `${from} → ${to}` : from || to || (s.length === 1 ? s[0].name || s[0].fileName : t(`${s.length} kayıt`));
  return `${where} · ${fmtDistance(m.distanceM)}`;
}
