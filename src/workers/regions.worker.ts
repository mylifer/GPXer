/// <reference lib="webworker" />
/** Gezilen il ve bölgelerin hesabı arka planda: kayıtlar (çizgi ve zamanlar)
 * işçide bir kez saklanır, her hesapta yalnızca yollar gönderilir. Arayüz
 * binlerce kayıtta bile takılmaz. */
import type { FileSummary } from "../api";
import { setTzMode, type TzMode } from "../format";
import { loadProvinces, loadWorldRegions, visitedProvinces } from "../regions";

export type RegionsRequest =
  | { type: "put"; items: FileSummary[] }
  | { type: "compute"; id: number; paths: string[]; world: boolean; from: string; to: string; tzMode: TzMode };

const files = new Map<string, FileSummary>();

self.onmessage = async (e: MessageEvent<RegionsRequest>) => {
  const m = e.data;
  if (m.type === "put") {
    for (const s of m.items) files.set(s.path, s);
    return;
  }
  try {
    setTzMode(m.tzMode);
    const fc = await (m.world ? loadWorldRegions() : loadProvinces());
    const list = m.paths.map((p) => files.get(p)).filter((s): s is FileSummary => s != null);
    self.postMessage({ id: m.id, visits: visitedProvinces(list, fc, m.from, m.to) });
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err) });
  }
};
