import type { FileMeta } from "./api";
import { dayBuckets } from "./days";
import { fmtDecimal, isoToTr } from "./format";
import { fuelFor, type FuelPrefs } from "./fuel";
import { placeLabel, type FileEntry } from "./types";

export interface MileageTrip {
  path: string;
  day: string;
  name: string;
  route: string;
  km: number;
  cost: number;
  note: string;
}

export interface MileageMonth {
  /** "2024-07" */
  month: string;
  trips: number;
  km: number;
  cost: number;
}

/** Etiketli (ör. "iş") kayıtların yıllık kilometre defteri: yolculuklar ve
 * aylık toplamlar. Etiket karşılaştırması büyük/küçük harf duyarsız. */
export function mileageLog(
  files: readonly FileEntry[],
  meta: Record<string, FileMeta>,
  tag: string,
  year: string,
  fuel: FuelPrefs,
): { trips: MileageTrip[]; months: MileageMonth[]; km: number; cost: number } {
  const want = tag.trim().toLocaleLowerCase("tr-TR");
  const trips: MileageTrip[] = [];
  for (const f of files) {
    const m = meta[f.summary.path];
    if (!m?.tags.some((t) => t.toLocaleLowerCase("tr-TR") === want)) continue;
    const day = dayBuckets(f.summary)[0]?.day;
    if (!day?.startsWith(year)) continue;
    const s = f.summary;
    const km = s.stats.distanceM / 1000;
    trips.push({
      path: s.path,
      day,
      name: s.name || s.fileName,
      route: placeLabel(s) ?? [s.startPlace, s.endPlace].filter(Boolean).join(" → "),
      km,
      cost: fuelFor(s.stats.distanceM, fuel).cost,
      note: m.note,
    });
  }
  trips.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const byMonth = new Map<string, MileageMonth>();
  for (const t of trips) {
    const k = t.day.slice(0, 7);
    const e = byMonth.get(k) ?? { month: k, trips: 0, km: 0, cost: 0 };
    e.trips++;
    e.km += t.km;
    e.cost += t.cost;
    byMonth.set(k, e);
  }
  return {
    trips,
    months: [...byMonth.values()],
    km: trips.reduce((a, t) => a + t.km, 0),
    cost: trips.reduce((a, t) => a + t.cost, 0),
  };
}

const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** Excel'in Türkçe ayarlarıyla açılan CSV (noktalı virgül, ondalık virgül, BOM). */
export function mileageCsv(log: ReturnType<typeof mileageLog>): string {
  const n = (v: number, d: number) => fmtDecimal(v, d);
  const rows = [["Tarih", "Kayıt", "Güzergâh", "Km", "Yakıt (₺)", "Not"]];
  for (const t of log.trips) rows.push([isoToTr(t.day), t.name, t.route, n(t.km, 1), n(t.cost, 0), t.note]);
  rows.push([]);
  rows.push(["Ay", "Yolculuk", "", "Km", "Yakıt (₺)", ""]);
  for (const m of log.months) rows.push([m.month, String(m.trips), "", n(m.km, 1), n(m.cost, 0), ""]);
  rows.push(["Toplam", String(log.trips.length), "", n(log.km, 1), n(log.cost, 0), ""]);
  return "﻿" + rows.map((r) => r.map(cell).join(";")).join("\r\n") + "\r\n";
}
