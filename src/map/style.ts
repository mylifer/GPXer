import * as maplibregl from "maplibre-gl";
import { fetchJson } from "./offline";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import { EMPTY } from "./geojson";

export type BaseLayer = "light" | "dark" | "osm" | "topo" | "satellite";

export const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  { id: "light", label: "Sade" },
  { id: "dark", label: "Koyu" },
  { id: "osm", label: "Sokak" },
  { id: "topo", label: "Topoğrafik" },
  { id: "satellite", label: "Uydu" },
];

/** Esri Canvas altlığı ve üstündeki yer adı katmanı için kaynaklar. */
function canvas(id: string, service: string): StyleSpecification["sources"] {
  const src = (name: string) => ({
    type: "raster" as const,
    tiles: [`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/${name}/MapServer/tile/{z}/{y}/{x}`],
    tileSize: 256,
    maxzoom: 16,
  });
  return {
    [id]: { ...src(`${service}_Base`), attribution: "Altlık © Esri, HERE, Garmin, © OpenStreetMap katkıcıları" },
    [`${id}-labels`]: src(`${service}_Reference`),
  };
}

export const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    // Soluk renkli, az ayrıntılı altlıklar: izler üzerinde belirgin durur.
    // Esri Canvas altlıkları anahtar gerektirmez; yer adları ayrı bir katmanda gelir.
    ...canvas("light", "World_Light_Gray"),
    ...canvas("dark", "World_Dark_Gray"),
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> katkıcıları',
    },
    topo: {
      type: "raster",
      tiles: ["a", "b", "c"].map((s) => `https://${s}.tile.opentopomap.org/{z}/{x}/{y}.png`),
      tileSize: 256,
      maxzoom: 17,
      attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), © OpenStreetMap',
    },
    satellite: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Görüntü © Esri, Maxar, Earthstar Geographics",
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#e9e6df" } },
    { id: "base-light", type: "raster", source: "light" },
    { id: "base-light-labels", type: "raster", source: "light-labels" },
    { id: "base-dark", type: "raster", source: "dark", layout: { visibility: "none" } },
    { id: "base-dark-labels", type: "raster", source: "dark-labels", layout: { visibility: "none" } },
    { id: "base-osm", type: "raster", source: "osm", layout: { visibility: "none" } },
    { id: "base-topo", type: "raster", source: "topo", layout: { visibility: "none" } },
    { id: "base-satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
  ],
};

/**
 * Sade ve Koyu için OpenFreeMap vektör stilleri (anahtar gerektirmez).
 * Vektör karolar her yakınlaşmada yeniden çizildiği için pikselleşmez.
 * Yüklenemezlerse STYLE içindeki Esri Canvas raster altlıkları kullanılır.
 */
export const VECTOR_STYLES: Partial<Record<BaseLayer, string>> = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

/** Raster altlıkların görüntü bulunan en yüksek düzeyi; bunun bir üstüne
 * kadar yakınlaşılabilir, daha fazlası yalnızca bulanık büyütme olurdu. */
export const RASTER_MAX_ZOOM: Record<BaseLayer, number> = {
  light: 16,
  dark: 16,
  osm: 19,
  topo: 17,
  satellite: 19,
};

/**
 * Vektör stilin kaynaklarını ve katmanlarını mevcut haritaya, izlerin altına
 * ekler. Katman adları "base-<id>-v-" ile başlar; böylece altlık değiştirme
 * mantığı onları diğer altlık katmanları gibi açıp kapatır.
 */
export async function addVectorBase(map: maplibregl.Map, id: BaseLayer, url: string): Promise<boolean> {
  const style = await fetchJson<StyleSpecification>(url);
  if (!style.layers?.length || !style.sources) return false;
  const srcPrefix = `${id}-v-`;
  for (const [name, src] of Object.entries(style.sources)) {
    if (!map.getSource(srcPrefix + name)) map.addSource(srcPrefix + name, src);
  }
  if (style.glyphs) map.setGlyphs(style.glyphs);
  // Altlık; kabartma gölgesinin, gezilen yer dolgularının ve izlerin altına.
  const before = ["hillshade", "regions-countries", "heat"].find((x) => map.getLayer(x));
  let added = 0;
  for (const layer of style.layers) {
    const l = { ...layer, id: `base-${id}-v-${layer.id}` } as LayerSpecification & {
      source?: string;
      layout?: Record<string, unknown>;
    };
    if (typeof l.source === "string") l.source = srcPrefix + l.source;
    // Simge sayfası (sprite) eklenmiyor; simgeli katmanlar yalnızca yazıyla çizilir.
    const { "icon-image": _icon, ...layout } = (l.layout ?? {}) as Record<string, unknown>;
    l.layout = { ...layout, visibility: "none" };
    try {
      map.addLayer(l as LayerSpecification, before);
      added++;
    } catch (e) {
      // Bu MapLibre sürümüne uymayan tek bir katman altlığın tamamını bozmasın.
      console.warn("Altlık katmanı atlandı:", layer.id, e);
    }
  }
  if (added === 0) return false;
  // Aynı altlığın raster yedeği artık gereksiz.
  for (const lid of [`base-${id}`, `base-${id}-labels`]) {
    if (map.getLayer(lid)) map.removeLayer(lid);
  }
  return true;
}

/** İzlerin, imlecin ve diğer katmanların kaynaklarını ve katmanlarını ekler
 * (stil yüklenince bir kez). */
export function addOverlayLayers(map: maplibregl.Map) {
  // Gezilen ülke ve iller: izlerin altında yarı saydam dolgu.
  for (const id of ["regions-countries", "regions-provinces"]) map.addSource(id, { type: "geojson", data: EMPTY, tolerance: 0.6 });
  map.addLayer({
    id: "regions-countries",
    type: "fill",
    source: "regions-countries",
    layout: { visibility: "none" },
    paint: { "fill-color": "#3c78d8", "fill-opacity": 0.16 },
  });
  map.addLayer({
    id: "regions-provinces",
    type: "fill",
    source: "regions-provinces",
    filter: ["==", ["get", "visited"], 1],
    layout: { visibility: "none" },
    paint: { "fill-color": "#e8743b", "fill-opacity": 0.3 },
  });
  map.addSource("explorer", { type: "geojson", data: EMPTY, tolerance: 0 });
  map.addLayer({
    id: "explorer",
    type: "fill",
    source: "explorer",
    filter: ["==", ["get", "kind"], "tile"],
    layout: { visibility: "none" },
    paint: { "fill-color": "#2f9d6a", "fill-opacity": 0.28, "fill-outline-color": "#2f9d6a" },
  });
  map.addLayer({
    id: "explorer-square",
    type: "line",
    source: "explorer",
    filter: ["==", ["get", "kind"], "square"],
    layout: { visibility: "none" },
    paint: { "line-color": "#1f6e49", "line-width": 3 },
  });
  map.addLayer({
    id: "regions-provinces-line",
    type: "line",
    source: "regions-provinces",
    layout: { visibility: "none" },
    paint: { "line-color": "#7a7f85", "line-width": 0.6, "line-opacity": 0.6 },
  });
  for (const id of ["tracks", "gaps", "waypoints", "cursor", "heat", "colored", "range", "stops", "hotspots", "area", "flights"]) {
    map.addSource(id, { type: "geojson", data: EMPTY, tolerance: id === "tracks" ? 0.2 : 0.375 });
  }

  map.addLayer({
    id: "heat",
    type: "heatmap",
    source: "heat",
    layout: { visibility: "none" },
    paint: {
      // Yüzlerce iz üst üste binince her yer doygun görünmesin diye ağırlık düşük.
      "heatmap-weight": 0.5,
      "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 12, 1, 16, 2],
      "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 2, 10, 4, 14, 8, 17, 14],
      "heatmap-opacity": 0.85,
    },
  });
  // İzlerin altında ince bir kontur: altlıktaki yollardan ayrışmalarını sağlar.
  map.addLayer({
    id: "tracks-casing",
    type: "line",
    source: "tracks",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 },
  });
  // Kayıt boşlukları: iz rengiyle ince kesik çizgi.
  map.addLayer({
    id: "gaps",
    type: "line",
    source: "gaps",
    filter: ["==", ["get", "path"], ""],
    layout: { "line-cap": "butt" },
    paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.8, "line-dasharray": [2, 3] },
  });
  // Uçuşlar: büyük daire yayı, iz renginde.
  map.addLayer({
    id: "flights-casing",
    type: "line",
    source: "flights",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 4.5, "line-opacity": 0.7 },
  });
  map.addLayer({
    id: "flights",
    type: "line",
    source: "flights",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 2.5, "line-opacity": 0.9, "line-dasharray": [4, 2] },
  });
  map.addLayer({
    id: "tracks",
    type: "line",
    source: "tracks",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.85 },
  });
  map.addLayer({
    id: "tracks-selected-casing",
    type: "line",
    source: "tracks",
    filter: ["==", ["get", "path"], ""],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": 8 },
  });
  map.addLayer({
    id: "tracks-selected",
    type: "line",
    source: "tracks",
    filter: ["==", ["get", "path"], ""],
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["get", "color"], "line-width": 5 },
  });
  map.addLayer({
    id: "colored",
    type: "line",
    source: "colored",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": ["get", "c"], "line-width": 5 },
  });
  map.addLayer({
    id: "range-casing",
    type: "line",
    source: "range",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#1d2327", "line-width": 10, "line-opacity": 0.7 },
  });
  map.addLayer({
    id: "range",
    type: "line",
    source: "range",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffd23f", "line-width": 5 },
  });
  map.addLayer({
    id: "waypoints",
    type: "circle",
    source: "waypoints",
    paint: {
      "circle-radius": 5,
      "circle-color": ["get", "color"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
  map.addLayer({
    id: "area-fill",
    type: "fill",
    source: "area",
    paint: { "fill-color": "#ffd23f", "fill-opacity": 0.08 },
  });
  map.addLayer({
    id: "area-line",
    type: "line",
    source: "area",
    paint: { "line-color": "#d29b00", "line-width": 2, "line-dasharray": [3, 2] },
  });
  // Sık durulan yerler: daire büyüklüğü durma sayısı (karekök ölçekli).
  map.addLayer({
    id: "hotspots",
    type: "circle",
    source: "hotspots",
    layout: { visibility: "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "n"]], 1, 5, 10, 24],
      "circle-color": "#e8553d",
      "circle-opacity": 0.35,
      "circle-stroke-color": "#e8553d",
      "circle-stroke-width": 1.5,
    },
  });
  map.addLayer({
    id: "stops",
    type: "circle",
    source: "stops",
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["get", "dur"], 120000, 6, 1800000, 13],
      "circle-color": ["case", ["==", ["get", "night"], 1], "#3c4fd8", "#ffffff"],
      "circle-stroke-color": ["case", ["==", ["get", "night"], 1], "#ffffff", "#1d2327"],
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: "cursor",
    type: "circle",
    source: "cursor",
    paint: {
      "circle-radius": 7,
      "circle-color": ["coalesce", ["get", "color"], "#e8553d"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 3,
    },
  });
  // Video kaydı: ilerledikçe çizilen iz ve baş noktası (yalnızca kayıt sırasında).
  for (const id of ["video-trail", "video-head"]) map.addSource(id, { type: "geojson", data: EMPTY });
  map.addLayer({
    id: "video-trail-casing",
    type: "line",
    source: "video-trail",
    layout: { visibility: "none", "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#ffffff", "line-width": 9 },
  });
  map.addLayer({
    id: "video-trail",
    type: "line",
    source: "video-trail",
    layout: { visibility: "none", "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#e8553d", "line-width": 5 },
  });
  map.addLayer({
    id: "video-head",
    type: "circle",
    source: "video-head",
    layout: { visibility: "none" },
    paint: { "circle-radius": 8, "circle-color": "#e8553d", "circle-stroke-color": "#fff", "circle-stroke-width": 3 },
  });
}
