/** Gezilen il/bölge hesabını arka plandaki işçiye yaptırır (bkz.
 * workers/regions.worker.ts). İşçi kullanılamazsa aynı hesap burada yapılır. */
import type { FileSummary } from "./api";
import { getTzMode } from "./format";
import { loadProvinces, loadWorldRegions, visitedProvinces, type ProvinceVisit } from "./regions";
import type { RegionsRequest } from "./workers/regions.worker";

let worker: Worker | null | undefined;
/** İşçiye gönderilmiş kayıtlar (aynı nesne değilse yeniden gönderilir: düzenlenen kayıt). */
const sent = new Map<string, FileSummary>();
const waiting = new Map<number, { ok(v: ProvinceVisit[]): void; fail(e: unknown): void }>();
let seq = 0;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("./workers/regions.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; visits?: ProvinceVisit[]; error?: string }>) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      if (e.data.visits) w.ok(e.data.visits);
      else w.fail(new Error(e.data.error));
    };
    worker.onerror = () => {
      // İşçi açılamadı: bekleyenler ve sonrakiler burada hesaplanır.
      worker = null;
      for (const w of waiting.values()) w.fail(new Error("işçi yok"));
      waiting.clear();
    };
  } catch {
    worker = null;
  }
  return worker;
}

/** Yalnızca hesapta kullanılan alanlar (işçiye kopyalanan veri az olsun). */
const slim = (s: FileSummary) =>
  ({ path: s.path, lines: s.lines, times: s.times, timeZone: s.timeZone, stats: { startTime: s.stats.startTime } }) as FileSummary;

async function local(files: FileSummary[], world: boolean, from: string, to: string) {
  return visitedProvinces(files, await (world ? loadWorldRegions() : loadProvinces()), from, to);
}

/** Gösterilen kayıtlarda geçilen il ve bölgeler (adlar Türkçe; anahtar `ülke|ad`). */
export function visitedRegions(files: FileSummary[], world: boolean, from: string, to: string): Promise<ProvinceVisit[]> {
  const w = getWorker();
  if (!w) return local(files, world, from, to);
  const items = files.filter((s) => sent.get(s.path) !== s);
  if (items.length) {
    for (const s of items) sent.set(s.path, s);
    w.postMessage({ type: "put", items: items.map(slim) } satisfies RegionsRequest);
  }
  const id = ++seq;
  return new Promise<ProvinceVisit[]>((ok, fail) => {
    waiting.set(id, { ok, fail });
    w.postMessage({ type: "compute", id, paths: files.map((s) => s.path), world, from, to, tzMode: getTzMode() } satisfies RegionsRequest);
  }).catch(() => local(files, world, from, to));
}
