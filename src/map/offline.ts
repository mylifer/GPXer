import * as maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";

/** Tauri içinde mi (tarayıcı denemelerinde karolar doğrudan istenir). */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SCHEME = "gpxc://";

/** Karolar uygulamanın disk önbelleğinden (yoksa internetten) gelir: görülen
 * ve indirilen bölgeler çevrimdışı açılır. */
export function installTileCache() {
  if (!inTauri) return;
  maplibregl.addProtocol("gpxc", async (params, abort) => {
    const url = params.url.slice(SCHEME.length);
    // Kaydırırken vazgeçilen karolar indirilmez (sıra görünen karolara kalsın).
    if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
    const buf = await invoke<ArrayBuffer>("tile", { url });
    if (params.type === "json") return { data: JSON.parse(new TextDecoder().decode(buf)) };
    if (params.type === "string") return { data: new TextDecoder().decode(buf) };
    return { data: buf };
  });
}

/** MapLibre isteklerini önbellek protokolüne yönlendirir. */
export function transformRequest(url: string): maplibregl.RequestParameters | undefined {
  if (!inTauri || !/^https?:\/\//.test(url)) return undefined;
  return { url: SCHEME + url };
}

/** Uygulama dışından alınan JSON (vektör stil) da önbellekten. */
export async function fetchJson<T>(url: string): Promise<T> {
  if (!inTauri) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }
  const buf = await invoke<ArrayBuffer>("tile", { url });
  return JSON.parse(new TextDecoder().decode(buf));
}

/** Toplu indirmeye izin vermeyen sunucular (OpenStreetMap karo kullanım koşulları). */
const NO_BULK = /tile\.openstreetmap\.org/;
const MAX_TILES = 4000;

const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};
/** Web Mercator karo sınırı (EPSG:3857, metre) — WMS için. */
const bbox3857 = (x: number, y: number, z: number) => {
  const size = (2 * Math.PI * 6378137) / 2 ** z;
  const o = Math.PI * 6378137;
  return [x * size - o, o - (y + 1) * size, (x + 1) * size - o, o - y * size].join(",");
};

const quadkey = (x: number, y: number, z: number) => {
  let q = "";
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
  }
  return q;
};

/** Görünen alanın, açık katmanlarda şu anki yakınlaştırmadan `extra` düzey
 * ötesine kadarki karo adresleri. Toplu indirmeye kapalı sunucular atlanır.
 * Düzey ve adres MapLibre'nin isteyeceğiyle aynı hesaplanır (karo boyutu,
 * raster yuvarlama, alt alan adı seçimi): yoksa çevrimdışı önbellekte bulunmaz. */
export function visibleTileUrls(map: maplibregl.Map, extra: number): { urls: string[]; skipped: string[]; capped: boolean } {
  const b = map.getBounds();
  const visible = new Set(
    map
      .getStyle()
      .layers.filter((l) => "source" in l && l.layout?.visibility !== "none")
      .map((l) => (l as { source: string }).source),
  );
  if (map.getTerrain()) visible.add(map.getTerrain()!.source);
  const urls = new Set<string>();
  const seen = new Set<string>();
  const skipped = new Set<string>();
  let capped = false;
  for (const id of visible) {
    const src = map.getSource(id) as
      | (maplibregl.Source & { tiles?: string[]; tileSize?: number; minzoom?: number; maxzoom?: number })
      | undefined;
    const tiles = src?.tiles;
    if (!src || !tiles?.length) continue;
    // Aynı karolar iki kaynakta (ör. arazi ve gölgelendirme) bir kez sayılır.
    const key = tiles.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    if (NO_BULK.test(tiles[0])) {
      skipped.add(new URL(tiles[0].replace(/\{[^}]+\}/g, "0")).host);
      continue;
    }
    const raster = src.type === "raster" || src.type === "raster-dem";
    const z = map.getZoom() + Math.log2(512 / (src.tileSize ?? 512));
    const zMin = src.minzoom ?? 0;
    const zMax = src.maxzoom ?? 18;
    const base = Math.max(zMin, Math.min(zMax, raster ? Math.round(z) : Math.floor(z)));
    const top = Math.min(base + extra, zMax);
    for (let zz = base; zz <= top && !capped; zz++) {
      const n = 2 ** zz;
      const wrapX = b.getEast() - b.getWest() >= 360;
      const [x0, x1] = wrapX ? [0, n - 1] : [lon2x(b.getWest(), zz), lon2x(b.getEast(), zz)];
      const [y0, y1] = [Math.max(0, lat2y(b.getNorth(), zz)), Math.min(n - 1, lat2y(b.getSouth(), zz))];
      for (let xr = x0; xr <= x1 && !capped; xr++) {
        // Tarih değiştirme çizgisinin ötesi dünyanın öbür ucundaki karolardır.
        const x = ((xr % n) + n) % n;
        for (let y = y0; y <= y1; y++) {
          if (urls.size >= MAX_TILES) {
            capped = true;
            break;
          }
          const tpl = tiles[(x + y) % tiles.length];
          urls.add(
            tpl
              .replace(/\{z\}/g, String(zz))
              .replace(/\{x\}/g, String(x))
              .replace(/\{y\}/g, String(y))
              .replace(/\{quadkey\}/g, quadkey(x, y, zz))
              .replace(/\{bbox-epsg-3857\}/g, bbox3857(x, y, zz)),
          );
        }
      }
    }
  }
  return { urls: [...urls], skipped: [...skipped], capped };
}
