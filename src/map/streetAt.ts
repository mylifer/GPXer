/** Hover kutusundaki "sokak · mahalle, ilçe" satırı: sonuçlar ~25 m'lik
 * hücrelerde saklanır; aynı anda tek istek gider, fare hızla giderken yalnızca
 * son nokta sorulur. */
import { streetAt } from "../api";
import { escapeHtml } from "./popups";

type Info = { street: string | null; area: string | null } | null;

const cache = new Map<string, Info>();
const keyOf = (lon: number, lat: number) => `${Math.round(lon * 4000)},${Math.round(lat * 4000)}`;
let busy = false;
let next: { lon: number; lat: number; done(): void } | null = null;

function run(lon: number, lat: number, done: () => void) {
  busy = true;
  const k = keyOf(lon, lat);
  streetAt(lon, lat)
    .then((r) => cache.set(k, r.street || r.area ? r : null))
    .catch(() => cache.set(k, null))
    .finally(() => {
      busy = false;
      if (cache.size > 5000) cache.clear();
      done();
      const n = next;
      next = null;
      if (n && !cache.has(keyOf(n.lon, n.lat))) run(n.lon, n.lat, n.done);
      else n?.done();
    });
}

/** Satırın HTML'i (bilinmiyorsa boş); bilinmiyorsa sorulur ve gelince `onReady` çağrılır. */
export function streetLine(lon: number, lat: number, onReady: () => void): string {
  const k = keyOf(lon, lat);
  if (cache.has(k)) {
    const r = cache.get(k);
    if (!r) return "";
    const text = [r.street, r.area].filter(Boolean).join(" · ");
    return `<br><span class="popup-street" data-no-i18n>📍 ${escapeHtml(text)}</span>`;
  }
  if (busy) next = { lon, lat, done: onReady };
  else run(lon, lat, onReady);
  return "";
}
