import type { FileSummary } from "../api";
import type { GoToResult } from "../components/GoToDialog";
import { wallToUtc } from "../format";
import { namedPlaceAt } from "../places";
import { countryName, visitAt } from "../visits";
import type { FileEntry } from "../types";

/** "Tarihe git": kayıt yoksa en fazla bu kadar uzaktaki kayda gidilir. */
const GOTO_NEAR_MS = 6 * 3_600_000;

/** Duvar saatindeki (gg.aa.yyyy ss:dd) ana en yakın kayıt. */
export function findAt(files: readonly FileEntry[], wall: number, record: boolean): GoToResult {
  let cover: { s: FileSummary; t: number; active: boolean; span: number } | null = null;
  let near: { s: FileSummary; t: number; dt: number } | null = null;
  for (const f of files) {
    const s = f.summary;
    const a = s.stats.startTime;
    const b = s.stats.endTime;
    if (a == null || b == null) continue;
    const t = wallToUtc(wall, record ? s.timeZone : null);
    if (t >= a && t <= b) {
      const h = Math.floor(t / 3_600_000) * 3_600_000;
      const active = !Array.isArray(s.hours) || s.hours.some((x) => x[0] === h);
      const span = b - a;
      // Verisi olan saatteki kayıt, sonra kısa kayıt tercih edilir.
      if (!cover || (active && !cover.active) || (active === cover.active && span < cover.span)) cover = { s, t, active, span };
    } else {
      const dt = t < a ? t - a : t - b;
      if (!near || Math.abs(dt) < Math.abs(near.dt)) near = { s, t: t < a ? a : b, dt };
    }
  }
  if (cover) return { kind: "cover", path: cover.s.path, t: cover.t };
  if (near) return { kind: "near", path: near.s.path, t: near.t, dt: near.dt, go: Math.abs(near.dt) <= GOTO_NEAR_MS };
  return { kind: "none" };
}

/** Kaydın `t` anına en yakın noktası (özetteki iz) ve o yerin adı. */
export function placeAtTime(s: FileSummary, t: number): { name: string | null; at: number | null } {
  let best: [number, number] | null = null;
  let at: number | null = null;
  s.lines.forEach((line, li) => {
    const ts = s.times[li] ?? [];
    for (let i = 0; i < line.length; i++) {
      const x = ts[i];
      if (x != null && (at == null || Math.abs(x - t) < Math.abs(at - t))) {
        at = x;
        best = line[i];
      }
    }
  });
  const pt = best as [number, number] | null;
  const named = pt ? namedPlaceAt(pt[0], pt[1]) : null;
  if (named) return { name: named.name, at };
  const v = visitAt(s, at ?? t);
  if (v) return { name: v.name ? `${v.name}${v.cc ? `, ${countryName(v.cc)}` : ""}` : countryName(v.cc), at };
  return { name: s.startPlace ?? null, at };
}
