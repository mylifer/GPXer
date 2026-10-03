import type { ExportFormat } from "../api";

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Yolun üst klasörü (son ayraçtan öncesi). */
export function parentDir(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : i === 0 ? p.slice(0, 1) : p;
}

/** Kaydetme penceresinde seçilen yolun uzantısından biçim. */
export function formatOf(path: string): { format: ExportFormat; hasExt: boolean } {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  // Yalnızca bilinen iz uzantıları uzantı sayılır: "12.05.2024 Yürüyüş"
  // ya da "a.csv" adına .gpx eklenir (uzantısız dosya yazılıyordu).
  const known = ext === "gpx" || ext === "kml" || ext === "tcx" || ext === "fit";
  return { format: known && ext !== "gpx" ? (ext as ExportFormat) : "gpx", hasExt: known };
}
