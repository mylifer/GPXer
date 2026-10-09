import type { FileEntry } from "./types";
import { activityOf } from "./types";
import type { FileMeta } from "./api";
import { fmtClock, fmtDate, fmtDecimal, fmtTime, tzOf } from "./format";

/**
 * Kayıt özetlerini Türkçe Excel'in doğrudan açabileceği CSV'ye çevirir:
 * alan ayırıcı noktalı virgül, ondalık ayırıcı virgül, UTF-8 BOM.
 */
export function csvFor(list: FileEntry[], meta: Record<string, FileMeta> = {}): string {
  const head = [
    "Ad",
    "Dosya",
    "Tür",
    "Başlangıç yeri",
    "Bitiş yeri",
    "Etiketler",
    "Not",
    "Tarih",
    "Başlangıç",
    "Bitiş",
    "Saat dilimi",
    "Mesafe (km)",
    "Toplam süre",
    "Hareket süresi",
    "Ort. hız (km/sa)",
    "Maks. hız (km/sa)",
    "Tırmanış (m)",
    "İniş (m)",
    "En düşük (m)",
    "En yüksek (m)",
    "Ort. nabız",
    "Maks. nabız",
    "Ort. kadans",
    "Ort. güç (W)",
    "Ort. sıcaklık (°C)",
    "Nokta sayısı",
  ];
  const cell = (raw: string) => {
    // Formül enjeksiyonu: = + - @ (ya da sekme/satır başı) ile başlayan metin
    // Excel'de formül olarak çalışabilir; başına kesme işareti eklenir.
    // Düz sayılar (ör. "-12,5") olduğu gibi kalır.
    const v = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+([.,]\d+)?$/.test(raw) ? `'${raw}` : raw;
    return /[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const rows = list.map((f) => {
    const s = f.summary;
    const st = s.stats;
    const tz = tzOf(s);
    const kmh = (v: number | null) => (v == null ? "" : fmtDecimal(v * 3.6, 1));
    return [
      s.name ?? "",
      s.fileName,
      activityOf(s.activity).label,
      s.startPlace ?? "",
      s.endPlace ?? "",
      (meta[s.path]?.tags ?? []).join(", "),
      meta[s.path]?.note ?? "",
      st.startTime == null ? "" : fmtDate(st.startTime, tz),
      st.startTime == null ? "" : fmtTime(st.startTime, tz),
      st.endTime == null ? "" : fmtTime(st.endTime, tz),
      tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      fmtDecimal(st.distanceM / 1000, 3),
      fmtClock(st.durationMs),
      fmtClock(st.movingMs),
      kmh(st.avgMovingSpeedMs),
      kmh(st.maxSpeedMs),
      fmtDecimal(st.elevationGainM, 0),
      fmtDecimal(st.elevationLossM, 0),
      fmtDecimal(st.minEleM, 0),
      fmtDecimal(st.maxEleM, 0),
      fmtDecimal(st.avgHr, 0),
      fmtDecimal(st.maxHr, 0),
      fmtDecimal(st.avgCad, 0),
      fmtDecimal(st.avgPower, 0),
      fmtDecimal(st.avgTemp, 1),
      String(st.pointCount),
    ].map(cell);
  });
  return "﻿" + [head.map(cell), ...rows].map((r) => r.join(";")).join("\r\n") + "\r\n";
}
