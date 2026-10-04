import type { FileSummary, NamedPlace } from "./api";
import { tzOf, wallToUtc } from "./format";
import { namedPlaceAt } from "./places";
import { visitsOf } from "./visits";

const H = 3_600_000;

export type DayItem =
  | { kind: "stop"; start: number; end: number; lon: number; lat: number; place: string; night: boolean }
  | { kind: "move"; start: number; end: number; distanceM: number; from: string; to: string; path: string }
  | { kind: "none"; start: number; end: number };

/** Günün başı ve sonu (gösterim saat dilimine göre; kayıt kipi seçiliyse ilk kaydınki). */
export function dayBounds(day: string, tz: string | undefined): [number, number] {
  const [y, m, d] = day.split("-").map(Number);
  return [wallToUtc(Date.UTC(y, m - 1, d), tz), wallToUtc(Date.UTC(y, m - 1, d + 1), tz)];
}

interface Span {
  a: number;
  b: number;
}
const merge = (xs: Span[]) => {
  const out: Span[] = [];
  for (const x of [...xs].sort((p, q) => p.a - q.a)) {
    const last = out[out.length - 1];
    if (last && x.a <= last.b) last.b = Math.max(last.b, x.b);
    else out.push({ ...x });
  }
  return out;
};

/** Bir günün akışı: duraklamalar, aradaki yolculuklar (mesafeleriyle) ve
 * kayıt olmayan aralıklar. Aynı yolculuğun kopyaları tek sayılır (aralıklar
 * birleşir, saatlik mesafede en uzun kayıt alınır). */
export function dayTimeline(files: FileSummary[], day: string, places: NamedPlace[]): DayItem[] {
  const tz = tzOf(files[0]);
  const [d0, d1] = dayBounds(day, tz);
  const recs = files.filter((s) => s.stats.startTime != null && s.stats.startTime < d1 && (s.stats.endTime ?? s.stats.startTime) > d0);
  if (!recs.length) return [];
  const clip = (a: number, b: number): Span | null => {
    const x = { a: Math.max(a, d0), b: Math.min(b, d1) };
    return x.b > x.a ? x : null;
  };
  // Yer adı: adlandırılmış yer, yoksa kaydın o saatteki yerleşim adı.
  const nameAt = (lon: number | null, lat: number | null, t: number) => {
    const p = lon != null && lat != null ? namedPlaceAt(lon, lat, places) : null;
    if (p) return p.name;
    for (const s of recs) {
      let name = "";
      for (const [h, , n] of visitsOf(s)) {
        if (h > t) break;
        if (n) name = n;
      }
      if (name) return name;
    }
    return "";
  };
  // Saatlik mesafe (kopyalarda en uzunu) ve saatin hangi kayda ait olduğu.
  const hourDist = new Map<number, { m: number; path: string }>();
  for (const s of recs)
    for (const [h, m] of Array.isArray(s.hours) ? s.hours : []) {
      if (h + H <= d0 || h >= d1) continue;
      const cur = hourDist.get(h);
      if (!cur || m > cur.m) hourDist.set(h, { m, path: s.path });
    }
  const covered = merge(recs.flatMap((s) => clip(s.stats.startTime!, s.stats.endTime ?? s.stats.startTime!) ?? []));
  // Duraklamalar (kayıt dışında kalan gece kesintileri de konaklama sayılır).
  const stopsRaw = recs.flatMap((s) =>
    (s.stops ?? []).flatMap((st) => {
      const c = clip(st.start, st.start + st.durationMs);
      return c ? [{ ...c, lon: st.lon, lat: st.lat }] : [];
    }),
  );
  const stops: (Span & { lon: number; lat: number })[] = [];
  for (const st of stopsRaw.sort((p, q) => p.a - q.a)) {
    const last = stops[stops.length - 1];
    if (last && st.a <= last.b) last.b = Math.max(last.b, st.b);
    else stops.push({ ...st });
  }
  const items: DayItem[] = [];
  const stopAt = (t: number) => stops.find((s) => s.a <= t && t < s.b);
  // Kayıtlı aralıklar duraklama ve yolculuk olarak bölünür; aralar "kayıt yok".
  let t = d0;
  let lastPlace = "";
  for (const c of covered) {
    if (c.a > t) items.push({ kind: "none", start: t, end: c.a });
    let cur = c.a;
    const inside = stops.filter((s) => s.b > c.a && s.a < c.b);
    for (const st of inside) {
      const a = Math.max(st.a, c.a);
      if (a > cur) items.push(move(cur, a));
      const b = Math.min(st.b, c.b);
      const place = nameAt(st.lon, st.lat, a);
      items.push({ kind: "stop", start: a, end: b, lon: st.lon, lat: st.lat, place, night: b - a >= 4 * H && (a <= d0 + 4 * H || b >= d1 - 2 * H) });
      lastPlace = place;
      cur = b;
    }
    if (c.b > cur) items.push(move(cur, c.b));
    t = c.b;
  }
  if (t < d1 && items.length) items.push({ kind: "none", start: t, end: d1 });

  function move(a: number, b: number): DayItem {
    let m = 0;
    let path = recs[0].path;
    let best = 0;
    for (let h = Math.floor(a / H) * H; h < b; h += H) {
      const x = hourDist.get(h);
      if (!x) continue;
      // Saatin mesafesi, saatin içindeki hareket süresine oranla paylaşılır.
      const moving = movingIn(h, h + H);
      const share = moving > 0 ? (Math.min(b, h + H) - Math.max(a, h)) / moving : 0;
      m += x.m * Math.min(1, share);
      if (x.m > best) {
        best = x.m;
        path = x.path;
      }
    }
    const after = stopAt(b);
    const to = after ? nameAt(after.lon, after.lat, b) : "";
    return { kind: "move", start: a, end: b, distanceM: m, from: lastPlace || nameAt(null, null, a), to: to || nameAt(null, null, b), path };
  }
  /** Saat içinde kayıt olup duraklama olmayan süre. */
  function movingIn(a: number, b: number) {
    let rec = 0;
    for (const c of covered) rec += Math.max(0, Math.min(b, c.b) - Math.max(a, c.a));
    let stopped = 0;
    for (const s of stops) stopped += Math.max(0, Math.min(b, s.b) - Math.max(a, s.a));
    return Math.max(0, rec - stopped);
  }
  // Çok kısa (2 dk altı) yolculuk parçaları atılır: duraklama kenarlarındaki titreşim.
  const kept = items.filter((x) => x.kind !== "move" || x.end - x.start >= 120_000 || x.distanceM >= 300);
  // Arada yolculuk kalmayan ardışık duraklamalar birleşir.
  const out: DayItem[] = [];
  for (const x of kept) {
    const last = out[out.length - 1];
    if (last?.kind === "stop" && x.kind === "stop") {
      last.end = x.end;
      last.night ||= x.night;
      last.place ||= x.place;
    } else out.push({ ...x });
  }
  return out;
}
