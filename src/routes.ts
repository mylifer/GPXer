/**
 * Tekrarlanan güzergâhları bulur: başlangıcı, bitişi ve izi birbirine yakın
 * kayıtlar aynı güzergâh sayılır (ör. her gün işe gidiş).
 */

import type { FileEntry } from "./types";
import { metersBetween, resample } from "./geo";

export interface Route {
  id: string;
  paths: string[];
}

const SAMPLES = 24;
/** Başlangıç/bitiş en fazla bu kadar uzak olabilir. */
const END_TOLERANCE_M = 300;
/** Eşit aralıklı noktalar arasındaki ortalama uzaklık sınırı. */
const SHAPE_TOLERANCE_M = 150;
/** Mesafeler en fazla bu oranda farklı olabilir. */
const LENGTH_RATIO = 0.15;

interface Sig {
  path: string;
  pts: [number, number][];
  dist: number;
  t: number;
}

function similar(a: Sig, b: Sig): boolean {
  if (Math.abs(a.dist - b.dist) > LENGTH_RATIO * Math.max(a.dist, b.dist)) return false;
  if (metersBetween(a.pts[0], b.pts[0]) > END_TOLERANCE_M) return false;
  if (metersBetween(a.pts[SAMPLES - 1], b.pts[SAMPLES - 1]) > END_TOLERANCE_M) return false;
  let sum = 0;
  for (let i = 0; i < SAMPLES; i++) {
    sum += metersBetween(a.pts[i], b.pts[i]);
    // Erken çıkış: ortalama sınırı aşılmak üzereyse devam etme.
    if (sum > SHAPE_TOLERANCE_M * SAMPLES) return false;
  }
  return sum / SAMPLES <= SHAPE_TOLERANCE_M;
}

/** En az iki kaydı olan güzergâhlar, kayıt sayısına göre çoktan aza. */
export function findRoutes(files: FileEntry[]): { routes: Route[]; byPath: Map<string, Route> } {
  const sigs: Sig[] = [];
  for (const f of files) {
    const s = f.summary;
    if (s.stats.distanceM < 300) continue;
    const pts = resample(s.lines, SAMPLES);
    if (pts) sigs.push({ path: s.path, pts, dist: s.stats.distanceM, t: s.stats.startTime ?? 0 });
  }
  sigs.sort((a, b) => a.t - b.t);
  const clusters: { rep: Sig; members: string[] }[] = [];
  for (const sig of sigs) {
    const c = clusters.find((c) => similar(c.rep, sig));
    if (c) c.members.push(sig.path);
    else clusters.push({ rep: sig, members: [sig.path] });
  }
  const routes = clusters
    .filter((c) => c.members.length > 1)
    .sort((a, b) => b.members.length - a.members.length)
    .map((c) => ({ id: c.rep.path, paths: c.members }));
  const byPath = new Map<string, Route>();
  for (const r of routes) for (const p of r.paths) byPath.set(p, r);
  return { routes, byPath };
}
