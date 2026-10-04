/** Kullanıcının eklediği harita katmanları (XYZ karo ya da WMS adresi). */
export interface CustomLayer {
  id: string;
  name: string;
  /** XYZ şablonu ({z}/{x}/{y}) ya da WMS GetMap adresi. */
  url: string;
  on: boolean;
  /** 0–1. */
  opacity: number;
}

/** Adres WMS mi (şablon değil, `service=WMS` ya da `/wms` içeriyor). */
export function isWms(url: string): boolean {
  return !/\{z\}/i.test(url) && /(service=wms|\/wms\b|request=getmap)/i.test(url);
}

/** MapLibre raster kaynağının karo adresi. WMS adreslerine eksik GetMap
 * parametreleri eklenir (EPSG:3857, 256 px karo). */
export function tileUrl(url: string): string {
  const u = url.trim();
  if (!isWms(u)) return u.replace(/\{s\}/g, "a");
  const has = (k: string) => new RegExp(`[?&]${k}=`, "i").test(u);
  const add: [string, string][] = [
    ["service", "WMS"],
    ["request", "GetMap"],
    ["version", "1.1.1"],
    ["format", "image/png"],
    ["transparent", "true"],
    ["srs", "EPSG:3857"],
    ["width", "256"],
    ["height", "256"],
    ["styles", ""],
  ];
  const extra = add.filter(([k]) => !has(k) && !(k === "srs" && has("crs"))).map(([k, v]) => `${k}=${v}`);
  const sep = u.includes("?") ? (u.endsWith("?") || u.endsWith("&") ? "" : "&") : "?";
  return `${u}${sep}${[...extra, has("bbox") ? "" : "bbox={bbox-epsg-3857}"].filter(Boolean).join("&")}`;
}

/** Adres kullanılabilir mi: https ve XYZ şablonu ya da WMS. */
export function validLayerUrl(url: string): string | null {
  const u = url.trim();
  if (!/^https:\/\//i.test(u)) return "Adres https:// ile başlamalı (güvenlik gereği şifresiz http kullanılamaz)";
  if (isWms(u)) return /[?&]layers=/i.test(u) ? null : "WMS adresinde layers= parametresi olmalı";
  if (!/\{z\}/i.test(u) || !/\{x\}/i.test(u) || !/\{y\}/i.test(u)) return "XYZ adresinde {z}, {x} ve {y} bulunmalı";
  return null;
}

export const isCustomLayers = (v: unknown): v is CustomLayer[] =>
  Array.isArray(v) &&
  v.every(
    (l) =>
      l &&
      typeof l.id === "string" &&
      typeof l.name === "string" &&
      typeof l.url === "string" &&
      typeof l.on === "boolean" &&
      typeof l.opacity === "number",
  );
