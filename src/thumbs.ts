/**
 * Fotoğraf küçük resimleri: yalnızca haritada çizilen işaretler (ve açılan
 * önizleme) için arka uçtan tembelce istenir. Bellekte LRU önbellek, aynı anda
 * en fazla birkaç istek; çizilmeyen işaretin bekleyen isteği iptal edilebilir.
 */

import { photoThumb } from "./api";

const CACHE_MAX = 500;
const CONCURRENCY = 4;

type Cb = (url: string | null) => void;

/** Ekleme sırası = kullanım sırası (Map); en eski baştadır. */
const cache = new Map<string, string | null>();
/** Bekleyen ya da yoldaki istekler ve sonucu bekleyenler. */
const waiting = new Map<string, Set<Cb>>();
const queue: string[] = [];
const inFlight = new Set<string>();

function put(path: string, url: string | null) {
  cache.delete(path);
  cache.set(path, url);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

/** Önbellekteki küçük resim: yüklenmediyse undefined, yoksa null. */
function cachedThumb(path: string): string | null | undefined {
  if (!cache.has(path)) return undefined;
  const v = cache.get(path)!;
  put(path, v); // son kullanılan
  return v;
}

function pump() {
  while (inFlight.size < CONCURRENCY && queue.length) {
    const path = queue.shift()!;
    if (!waiting.get(path)?.size) {
      waiting.delete(path);
      continue;
    }
    inFlight.add(path);
    photoThumb(path)
      .then((v) => (typeof v === "string" ? v : null))
      .catch(() => null)
      .then((url) => {
        inFlight.delete(path);
        put(path, url);
        const cbs = waiting.get(path);
        waiting.delete(path);
        cbs?.forEach((cb) => cb(url));
        pump();
      });
  }
}

/** Küçük resmi ister; önbellekteyse `cb` hemen çağrılır. Dönen işlev isteği
 * (henüz başlamadıysa) iptal eder. */
export function requestThumb(path: string, cb: Cb): () => void {
  const hit = cachedThumb(path);
  if (hit !== undefined) {
    cb(hit);
    return () => {};
  }
  let set = waiting.get(path);
  if (!set) {
    waiting.set(path, (set = new Set()));
    queue.push(path);
  }
  set.add(cb);
  pump();
  return () => {
    const s = waiting.get(path);
    if (!s) return;
    s.delete(cb);
    if (!s.size && !inFlight.has(path)) {
      waiting.delete(path);
      const i = queue.indexOf(path);
      if (i >= 0) queue.splice(i, 1);
    }
  };
}
