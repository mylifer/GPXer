import * as maplibregl from "maplibre-gl";
import { invoke } from "@tauri-apps/api/core";

/** Tauri içinde mi (tarayıcı denemelerinde karolar doğrudan istenir). */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const SCHEME = "gpxc://";

/** Karolar uygulamanın disk önbelleğinden (yoksa internetten) gelir: görülen
 * ve indirilen bölgeler çevrimdışı açılır. */
export function installTileCache() {
  if (!inTauri) return;
  maplibregl.addProtocol("gpxc", async (params) => {
    const url = params.url.slice(SCHEME.length);
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

/** Görünen alanın, açık katmanlarda şu anki yakınlaştırmadan `extra` düzey
 * ötesine kadarki karo adresleri. Toplu indirmeye kapalı sunucular atlanır. */
export function visibleTileUrls(map: maplibregl.Map, extra: number): { urls: string[]; skipped: string[]; capped: boolean } {
  const b = map.getBounds();
  const z0 = Math.max(0, Math.floor(map.getZoom()));
  const visible = new Set(
    map
      .getStyle()
      .layers.filter((l) => "source" in l && l.layout?.visibility !== "none")
      .map((l) => (l as { source: string }).source),
  );
  if (map.getTerrain()) visible.add(map.getTerrain()!.source);
  const urls: string[] = [];
  const skipped = new Set<string>();
  let capped = false;
  for (const id of visible) {
    const src = map.getSource(id) as (maplibregl.Source & { tiles?: string[]; maxzoom?: number }) | undefined;
    const tpl = src?.tiles?.[0];
    if (!tpl) continue;
    if (NO_BULK.test(tpl)) {
      skipped.add(new URL(tpl.replace(/\{[^}]+\}/g, "0")).host);
      continue;
    }
    const zMax = Math.min(z0 + extra, src?.maxzoom ?? 18);
    for (let z = Math.min(z0, zMax); z <= zMax; z++) {
      const [x0, x1] = [lon2x(b.getWest(), z), lon2x(b.getEast(), z)];
      const [y0, y1] = [lat2y(b.getNorth(), z), lat2y(b.getSouth(), z)];
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++) {
          if (urls.length >= MAX_TILES) {
            capped = true;
            break;
          }
          urls.push(
            tpl
              .replace("{z}", String(z))
              .replace("{x}", String(x))
              .replace("{y}", String(y))
              .replace("{bbox-epsg-3857}", bbox3857(x, y, z)),
          );
        }
    }
  }
  return { urls, skipped: [...skipped], capped };
}
