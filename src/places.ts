/**
 * Adlandırılmış yerler ("Ev", "İş"): kullanıcı bir duraklamaya ya da sık durulan
 * yere ad verir; yarıçap içindeki başlangıç/bitiş noktaları ve duraklamalar o
 * adla gösterilir. Liste arka uçta saklanır (get_places / set_places); burada
 * yalnızca güncel kopyası tutulur (saat dilimi kipi gibi modül düzeyinde).
 */

import type { NamedPlace } from "./api";
import { metersBetween } from "./geo";

export const DEFAULT_RADIUS_M = 150;

let current: NamedPlace[] = [];

export function setNamedPlaces(list: NamedPlace[]) {
  current = list;
}

export const namedPlaces = () => current;

/** Noktayı yarıçapı içine alan en yakın adlandırılmış yer. */
export function namedPlaceAt(lon: number, lat: number, list: readonly NamedPlace[] = current): NamedPlace | null {
  let best: NamedPlace | null = null;
  let bestD = Infinity;
  for (const p of list) {
    // Kaba ön eleme: enlem farkı yarıçaptan büyükse hesaplamaya gerek yok.
    if (Math.abs(p.lat - lat) * 110_574 > p.radiusM) continue;
    const d = metersBetween([p.lon, p.lat], [lon, lat]);
    if (d <= p.radiusM && d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

export function newPlaceId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
