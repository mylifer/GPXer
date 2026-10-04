import type { FileSummary, NamedPlace } from "./api";
import { tzOffsetMs } from "./format";
import { namedPlaceAt } from "./places";
import { visitsOf } from "./visits";
import { metersBetween } from "./geo";

/** Çok günlük kayıtta bir gecenin geçirildiği yer. */
export interface Night {
  lat: number;
  lon: number;
  /** Durmanın (ya da kaydın kesildiği aralığın) başı ve sonu. */
  start: number;
  end: number;
  /** Yer adı: adlandırılmış yer, yoksa kayıttaki yerleşim adı. */
  place: string;
}

const H = 3_600_000;
/** En az bu kadar süren duraklama ya da kesinti gece sayılabilir. */
const MIN_MS = 4 * H;

/** Aralık yerel saatle 03:00'ü kapsıyor mu (kaydın kendi saat dilimiyle). */
function coversNight(a: number, b: number, tz: string | null): boolean {
  const off = tzOffsetMs(a, tz);
  const wallA = a + off;
  const day = Math.floor(wallA / (24 * H)) * 24 * H;
  let three = day + 3 * H;
  if (three < wallA) three += 24 * H;
  return three - off <= b;
}

const cache = new WeakMap<FileSummary, Night[]>();
/** Kaydın konakladığı yerler: gece 03:00'ü kapsayan en az 4 saatlik
 * duraklamalar ve yerinde kesilmiş kayıt aralıkları (telefon gece kapalı). */
export function nightsOf(s: FileSummary, places: NamedPlace[] = []): Night[] {
  const hit = cache.get(s);
  if (hit && !places.length) return hit;
  const cands: Omit<Night, "place">[] = [];
  for (const st of s.stops ?? [])
    if (st.durationMs >= MIN_MS) cands.push({ lat: st.lat, lon: st.lon, start: st.start, end: st.start + st.durationMs });
  for (const g of s.gaps ?? []) {
    if (g.start == null || g.end == null || g.end - g.start < MIN_MS) continue;
    // Kayıt kesilip başka yerde yeniden başladıysa (uçuş, kapalı telefonla yol) konaklama değil.
    if (metersBetween(g.from, g.to) > 2000) continue;
    cands.push({ lat: g.from[1], lon: g.from[0], start: g.start, end: g.end });
  }
  const visits = visitsOf(s);
  const nameAt = (t: number) => {
    let name = "";
    for (const [h, , n] of visits) {
      if (h > t) break;
      if (n) name = n;
    }
    return name;
  };
  const out = cands
    .filter((c) => coversNight(c.start, c.end, s.timeZone))
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ ...c, place: namedPlaceAt(c.lon, c.lat, places)?.name ?? nameAt(c.start) }));
  if (!places.length) cache.set(s, out);
  return out;
}
