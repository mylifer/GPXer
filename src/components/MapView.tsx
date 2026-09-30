import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import {
  type GeoJSONSource,
  type LayerSpecification,
  type LngLatBoundsLike,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre worker'ı kendi yanında arar; bu Vite paketinde ve tauri:// adresinde
// çalışmadığı için worker'ı Vite'a ayrı parça olarak paketletip adresini veriyoruz.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Detail, FileSummary } from "../api";
import { METRICS, SEQ_DARK, SEQ_LIGHT, type FileEntry } from "../types";
import type { TrackColorBy } from "../prefs";
import { fmtDate, fmtDistance, fmtKmh, fmtTimestamp, fmtUnit, tzOf } from "../format";

maplibregl.setWorkerUrl(workerUrl);

export type BaseLayer = "light" | "dark" | "osm" | "topo" | "satellite";

export const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  { id: "light", label: "Sade" },
  { id: "dark", label: "Koyu" },
  { id: "osm", label: "Sokak" },
  { id: "topo", label: "Topoğrafik" },
  { id: "satellite", label: "Uydu" },
];

export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export interface MapHandle {
  fitFiles(files: FileEntry[]): void;
  fitPoints(lonLat: [number, number][]): void;
  /** Haritanın görüntüsünü PNG olarak (base64, önek olmadan) verir. */
  exportPng(): Promise<string>;
}

interface Props {
  files: FileEntry[];
  selected: string | null;
  detail: Detail | null;
  hoverIdx: number | null;
  onHoverIdx(i: number | null): void;
  /** Grafikte seçilen aralık (detay örnek sıraları). */
  range: [number, number] | null;
  trackColorBy: TrackColorBy;
  heatmap: boolean;
  /** Oynatılırken imleci görünür tut. */
  followCursor: boolean;
  baseLayer: BaseLayer;
  initialView: MapViewState | null;
  onViewChange(v: MapViewState): void;
  onSelect(path: string | null): void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

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

const STYLE: StyleSpecification = {
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
const VECTOR_STYLES: Partial<Record<BaseLayer, string>> = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};

/** Raster altlıkların görüntü bulunan en yüksek düzeyi; bunun bir üstüne
 * kadar yakınlaşılabilir, daha fazlası yalnızca bulanık büyütme olurdu. */
const RASTER_MAX_ZOOM: Record<BaseLayer, number> = {
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
async function addVectorBase(map: maplibregl.Map, id: BaseLayer, url: string): Promise<boolean> {
  const res = await fetch(url);
  if (!res.ok) return false;
  const style = (await res.json()) as StyleSpecification;
  if (!style.layers?.length || !style.sources) return false;
  const srcPrefix = `${id}-v-`;
  for (const [name, src] of Object.entries(style.sources)) {
    if (!map.getSource(srcPrefix + name)) map.addSource(srcPrefix + name, src);
  }
  if (style.glyphs) map.setGlyphs(style.glyphs);
  const before = map.getLayer("heat") ? "heat" : undefined;
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

function tracksGeoJSON(files: FileEntry[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: files.map((f) => ({
      type: "Feature",
      properties: { path: f.summary.path, color: f.color },
      geometry: { type: "MultiLineString", coordinates: f.summary.lines },
    })),
  };
}

function waypointsGeoJSON(files: FileEntry[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of files) {
    for (const w of f.summary.waypoints) {
      features.push({
        type: "Feature",
        properties: { path: f.summary.path, color: f.color, name: w.name ?? "" },
        geometry: { type: "Point", coordinates: [w.lon, w.lat] },
      });
    }
  }
  return { type: "FeatureCollection", features };
}

/** Isı haritası için izleri eşit aralıklı noktalara böler; böylece virajlı
 * yerler (sadeleştirmede daha çok nokta kalır) olduğundan yoğun görünmez. */
function heatGeoJSON(files: FileEntry[], stepM = 40): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const f of files) {
    for (const line of f.summary.lines) {
      let carry = 0;
      for (let j = 0; j + 1 < line.length; j++) {
        const [x0, y0] = line[j];
        const [x1, y1] = line[j + 1];
        const kx = 111_320 * Math.cos((y0 * Math.PI) / 180);
        const seg = Math.hypot((x1 - x0) * kx, (y1 - y0) * 110_574);
        let t = stepM - carry;
        while (t <= seg) {
          const r = t / seg;
          features.push({
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [x0 + (x1 - x0) * r, y0 + (y1 - y0) * r] },
          });
          t += stepM;
        }
        carry = (carry + seg) % stepM;
      }
    }
  }
  return { type: "FeatureCollection", features };
}

export function boundsOf(files: FileEntry[]): LngLatBoundsLike | null {
  let b: [number, number, number, number] | null = null;
  for (const f of files) {
    const x = f.summary.stats.bbox;
    if (!x) continue;
    b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : [...x];
  }
  return b ? [[b[0], b[1]], [b[2], b[3]]] : null;
}

/** Renklendirme için değer aralığı: uç değerler (GPS sıçramaları) skalayı
 * bozmasın diye %5–%95 dilimleri alınır. */
export function metricDomain(values: (number | null)[]): [number, number] | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const lo = v[Math.floor(v.length * 0.05)];
  const hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.95))];
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/** İmlecin altındaki noktanın zamanı: çizginin en yakın parçası bulunur ve
 * iki ucunun zamanı arasında konuma göre doğrusal ara değer alınır. */
function timeAt(summary: FileSummary, lon: number, lat: number): number | null {
  const { lines, times } = summary;
  if (times.length === 0) return null;
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let bestLine = -1;
  let bestIdx = 0;
  let bestT = 0;
  lines.forEach((line, li) => {
    for (let j = 0; j + 1 < line.length; j++) {
      const ax = line[j][0] * kx;
      const ay = line[j][1];
      const dx = line[j + 1][0] * kx - ax;
      const dy = line[j + 1][1] - ay;
      const px = lon * kx - ax;
      const py = lat - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
      const d2 = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d2 < best) {
        best = d2;
        bestLine = li;
        bestIdx = j;
        bestT = t;
      }
    }
  });
  if (bestLine < 0) return null;
  const ta = times[bestLine]?.[bestIdx] ?? null;
  const tb = times[bestLine]?.[bestIdx + 1] ?? null;
  if (ta != null && tb != null) return Math.round(ta + (tb - ta) * bestT);
  return bestT < 0.5 ? (ta ?? tb) : (tb ?? ta);
}

/** Detay örnekleri arasında imlece en yakın olanın sırası. */
function nearestDetail(d: Detail, lon: number, lat: number): number {
  const kx = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  let idx = 0;
  for (let i = 0; i < d.lat.length; i++) {
    const dd = ((d.lon[i] - lon) * kx) ** 2 + (d.lat[i] - lat) ** 2;
    if (dd < best) {
      best = dd;
      idx = i;
    }
  }
  return idx;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function detailPopupHtml(s: FileSummary, d: Detail, i: number): string {
  const tz = tzOf(s);
  const rows: string[] = [
    `<strong>${escapeHtml(s.name || s.fileName)}</strong>`,
    `<span class="popup-time">${fmtTimestamp(d.time[i], tz)}</span>`,
    `${fmtDistance(d.dist[i])} · ${fmtUnit(d.ele[i], "m")} · ${fmtKmh(d.speed[i])}`,
  ];
  const extra: string[] = [];
  for (const m of ["hr", "cad", "power", "temp"] as const) {
    const v = d[m][i];
    if (v != null) extra.push(`${METRICS[m].label} ${fmtUnit(v, METRICS[m].unit, METRICS[m].digits)}`);
  }
  if (extra.length) rows.push(extra.join(" · "));
  return rows.join("<br>");
}

const hitBox = (p: maplibregl.Point, r = 5): [maplibregl.PointLike, maplibregl.PointLike] => [
  [p.x - r, p.y - r],
  [p.x + r, p.y + r],
];

export const MapView = forwardRef<MapHandle, Props>(function MapView(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  /** Harita yüklenmeden önce gelen güncellemeler. */
  const pendingRef = useRef<((map: maplibregl.Map) => void)[]>([]);
  // Olay işleyicileri her zaman güncel değerleri görsün.
  const live = useRef(props);
  live.current = props;
  const hoverPopup = useRef<maplibregl.Popup | null>(null);
  const chooser = useRef<maplibregl.Popup | null>(null);
  /** İmleç konumunu şu an harita mı belirliyor. */
  const mapHovering = useRef(false);
  /** Vektör stilleri: yükleniyor / yüklendi / yüklenemedi (raster yedek). */
  const vectorState = useRef<Partial<Record<BaseLayer, "loading" | "ok" | "failed">>>({});

  const { files, selected, detail, hoverIdx, range, trackColorBy, heatmap, followCursor, baseLayer } = props;

  useImperativeHandle(ref, () => ({
    fitFiles(list) {
      const map = mapRef.current;
      const b = boundsOf(list);
      if (!map || !b) return;
      map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 600 });
    },
    fitPoints(pts) {
      const map = mapRef.current;
      if (!map || pts.length === 0) return;
      const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) b.extend(p);
      map.fitBounds(b, { padding: 80, maxZoom: 17, duration: 600 });
    },
    exportPng() {
      const map = mapRef.current;
      if (!map) return Promise.reject(new Error("Harita hazır değil"));
      return new Promise((resolve, reject) => {
        // WebGL tamponu yalnızca çizim anında okunabilir.
        map.once("render", () => {
          try {
            const src = map.getCanvas();
            const out = document.createElement("canvas");
            out.width = src.width;
            out.height = src.height;
            const ctx = out.getContext("2d")!;
            ctx.drawImage(src, 0, 0);
            const attrib = container.current?.querySelector(".maplibregl-ctrl-attrib-inner")?.textContent?.trim();
            const text = `GPXer${attrib ? " · " + attrib : ""}`;
            const scale = window.devicePixelRatio || 1;
            ctx.font = `${11 * scale}px system-ui, sans-serif`;
            const w = ctx.measureText(text).width + 12 * scale;
            ctx.fillStyle = "rgba(255,255,255,0.8)";
            ctx.fillRect(out.width - w, out.height - 18 * scale, w, 18 * scale);
            ctx.fillStyle = "#333";
            ctx.fillText(text, out.width - w + 6 * scale, out.height - 5 * scale);
            resolve(out.toDataURL("image/png").split(",")[1]);
          } catch (e) {
            reject(e);
          }
        });
        map.triggerRepaint();
      });
    },
  }));

  useEffect(() => {
    const init = live.current.initialView;
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      center: init?.center ?? [35, 39],
      zoom: init?.zoom ?? 5,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    map.on("moveend", () => {
      const c = map.getCenter();
      live.current.onViewChange({ center: [c.lng, c.lat], zoom: map.getZoom() });
    });

    // "load" altlık parçaları gelene kadar beklediği için (yavaş ya da kopuk
    // bağlantıda hiç gelmeyebilir) izler stil hazır olur olmaz eklenir.
    map.once("style.load", () => {
      for (const id of ["tracks", "waypoints", "cursor", "heat", "colored", "range"]) {
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
        id: "cursor",
        type: "circle",
        source: "cursor",
        paint: {
          "circle-radius": 7,
          "circle-color": "#e8553d",
          "circle-stroke-color": "#fff",
          "circle-stroke-width": 3,
        },
      });

      const trackHits = (p: maplibregl.Point, r = 5) => {
        const seen = new Set<string>();
        const out: string[] = [];
        for (const f of map.queryRenderedFeatures(hitBox(p, r), { layers: ["tracks", "tracks-selected"] })) {
          const path = String(f.properties?.path);
          if (!seen.has(path)) {
            seen.add(path);
            out.push(path);
          }
        }
        return out;
      };

      const releaseHover = () => {
        if (mapHovering.current) {
          mapHovering.current = false;
          live.current.onHoverIdx(null);
        }
      };

      map.on("click", (e) => {
        chooser.current?.remove();
        const wp = map.queryRenderedFeatures(hitBox(e.point, 4), { layers: ["waypoints"] })[0];
        if (wp) {
          const name = String(wp.properties?.name || "Nokta");
          new maplibregl.Popup({ closeButton: false })
            .setLngLat((wp.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(`<strong>${escapeHtml(name)}</strong>`)
            .addTo(map);
          return;
        }
        const hits = trackHits(e.point, 6);
        if (hits.length <= 1) {
          live.current.onSelect(hits[0] ?? null);
          return;
        }
        // Üst üste binen izler: hangisinin seçileceğini sor.
        const byPath = new Map(live.current.files.map((f) => [f.summary.path, f]));
        const box = document.createElement("div");
        box.className = "chooser";
        const title = document.createElement("div");
        title.className = "chooser-title";
        title.textContent = `Burada ${hits.length} iz var`;
        box.appendChild(title);
        for (const path of hits.slice(0, 12)) {
          const f = byPath.get(path);
          if (!f) continue;
          const s = f.summary;
          const b = document.createElement("button");
          b.innerHTML = `<span class="swatch" style="background:${f.color}"></span><span><strong>${escapeHtml(
            s.name || s.fileName,
          )}</strong><br><small>${fmtDate(s.stats.startTime, tzOf(s))} · ${fmtDistance(s.stats.distanceM)}</small></span>`;
          b.onclick = () => {
            chooser.current?.remove();
            live.current.onSelect(path);
          };
          box.appendChild(b);
        }
        if (hits.length > 12) {
          const more = document.createElement("div");
          more.className = "chooser-more";
          more.textContent = `… ve ${hits.length - 12} iz daha (yakınlaştırın)`;
          box.appendChild(more);
        }
        hoverPopup.current?.remove();
        chooser.current = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "chooser-popup" })
          .setLngLat(e.lngLat)
          .setDOMContent(box)
          .addTo(map);
      });

      map.on("mousemove", (e) => {
        const { files: fs, selected: sel, detail: d, heatmap: heatOn } = live.current;
        const hits = trackHits(e.point);
        const wp = hits.length ? null : map.queryRenderedFeatures(hitBox(e.point, 4), { layers: ["waypoints"] })[0];
        map.getCanvas().style.cursor = hits.length || wp ? "pointer" : "";
        if (chooser.current?.isOpen()) return;
        // Seçili iz imlecin altındaysa ona öncelik verilir.
        const path = sel && hits.includes(sel) ? sel : (hits[0] ?? null);
        const entry = path ? fs.find((f) => f.summary.path === path) : null;
        if (!entry || (heatOn && path !== sel)) {
          hoverPopup.current?.remove();
          releaseHover();
          return;
        }
        const s = entry.summary;
        let html: string;
        if (path === sel && d && d.lat.length) {
          const i = nearestDetail(d, e.lngLat.lng, e.lngLat.lat);
          mapHovering.current = true;
          live.current.onHoverIdx(i);
          html = detailPopupHtml(s, d, i);
        } else {
          releaseHover();
          const t = timeAt(s, e.lngLat.lng, e.lngLat.lat);
          html =
            `<strong>${escapeHtml(s.name || s.fileName)}</strong><br>` +
            (t != null
              ? `<span class="popup-time">${fmtTimestamp(t, tzOf(s))}</span><br>${fmtDistance(s.stats.distanceM)}`
              : `${fmtDate(s.stats.startTime, tzOf(s))} · ${fmtDistance(s.stats.distanceM)}`) +
            (hits.length > 1 ? `<br><small>${hits.length} iz üst üste · tıklayıp seçin</small>` : "");
        }
        if (!hoverPopup.current) {
          hoverPopup.current = new maplibregl.Popup({
            closeButton: false,
            closeOnClick: false,
            offset: 14,
            className: "hover-popup",
          });
        }
        hoverPopup.current.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on("mouseout", () => {
        hoverPopup.current?.remove();
        releaseHover();
      });

      readyRef.current = true;
      const pending = pendingRef.current;
      pendingRef.current = [];
      pending.forEach((fn) => fn(map));
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current!);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
      pendingRef.current = [];
    };
  }, []);

  // Harita hazır olduğunda ya da hemen: bir efekt işini çalıştırır.
  const whenReady = (fn: (map: maplibregl.Map) => void) => {
    const map = mapRef.current;
    if (!map) return;
    if (readyRef.current) fn(map);
    else pendingRef.current.push(fn);
  };

  const setData = (map: maplibregl.Map, id: string, data: GeoJSON.GeoJSON) =>
    (map.getSource(id) as GeoJSONSource).setData(data);

  useEffect(() => {
    whenReady((map) => {
      setData(map, "tracks", tracksGeoJSON(files));
      setData(map, "waypoints", waypointsGeoJSON(files));
    });
  }, [files]);

  useEffect(() => {
    whenReady((map) => setData(map, "heat", heatmap ? heatGeoJSON(files) : EMPTY));
  }, [files, heatmap]);

  const dark = baseLayer === "dark" || baseLayer === "satellite";

  useEffect(() => {
    whenReady((map) => {
      const vis = (id: string, on: boolean) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      vis("heat", heatmap);
      vis("tracks", !heatmap);
      vis("tracks-casing", !heatmap);
      vis("waypoints", !heatmap);
      const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
      map.setPaintProperty("heat", "heatmap-color", [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(0,0,0,0)",
        0.03,
        ramp[0],
        0.2,
        ramp[2],
        0.45,
        ramp[4],
        0.75,
        ramp[5],
        1,
        ramp[6],
      ]);
    });
  }, [heatmap, dark]);

  useEffect(() => {
    whenReady((map) => {
      const f: maplibregl.FilterSpecification = ["==", ["get", "path"], selected ?? ""];
      map.setFilter("tracks-selected", f);
      map.setFilter("tracks-selected-casing", f);
      map.setPaintProperty("tracks", "line-opacity", selected ? 0.45 : 0.85);
      map.setPaintProperty("tracks-casing", "line-opacity", selected ? 0.4 : 0.9);
    });
  }, [selected]);

  // Seçili izi ölçüye göre renklendir.
  useEffect(() => {
    whenReady((map) => {
      const values = detail && trackColorBy !== "none" ? (detail[trackColorBy] as (number | null)[]) : null;
      const domain = values ? metricDomain(values) : null;
      map.setLayoutProperty("tracks-selected", "visibility", domain ? "none" : "visible");
      if (!detail || !values || !domain) {
        setData(map, "colored", EMPTY);
        return;
      }
      const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
      const [lo, hi] = domain;
      const features: GeoJSON.Feature[] = [];
      for (let i = 0; i + 1 < detail.lat.length; i++) {
        const v = values[i];
        if (v == null) continue;
        const t = (v - lo) / (hi - lo);
        const k = Math.max(0, Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1))));
        features.push({
          type: "Feature",
          properties: { c: ramp[k] },
          geometry: {
            type: "LineString",
            coordinates: [
              [detail.lon[i], detail.lat[i]],
              [detail.lon[i + 1], detail.lat[i + 1]],
            ],
          },
        });
      }
      setData(map, "colored", { type: "FeatureCollection", features });
    });
  }, [detail, trackColorBy, dark]);

  useEffect(() => {
    whenReady((map) => {
      if (!detail || !range) return setData(map, "range", EMPTY);
      const coords: [number, number][] = [];
      for (let i = range[0]; i <= range[1] && i < detail.lat.length; i++) coords.push([detail.lon[i], detail.lat[i]]);
      setData(map, "range", { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });
    });
  }, [detail, range]);

  useEffect(() => {
    whenReady((map) => {
      const has = detail && hoverIdx != null && hoverIdx < detail.lat.length;
      const pt: [number, number] | null = has ? [detail!.lon[hoverIdx!], detail!.lat[hoverIdx!]] : null;
      setData(
        map,
        "cursor",
        pt ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pt } } : EMPTY,
      );
      // Oynatılırken imleç ekranın ortasındaki bölgeden çıkarsa harita kayar.
      if (pt && followCursor) {
        const p = map.project(pt);
        const c = map.getContainer();
        const mx = c.clientWidth * 0.2;
        const my = c.clientHeight * 0.2;
        if (p.x < mx || p.y < my || p.x > c.clientWidth - mx || p.y > c.clientHeight - my) {
          map.panTo(pt, { duration: 300 });
        }
      }
    });
  }, [detail, hoverIdx, followCursor]);

  useEffect(() => {
    const apply = (map: maplibregl.Map, base: BaseLayer) => {
      for (const { id } of map.getStyle().layers) {
        if (!id.startsWith("base-")) continue;
        const on = id === `base-${base}` || id.startsWith(`base-${base}-`);
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      }
      // Vektör stil yüklenirken sınır konmaz (kayıtlı yakın görünüm geri
      // çekilmesin); yalnızca raster altlıkta görüntünün bittiği düzeyde durulur.
      const vector = VECTOR_STYLES[base] && vectorState.current[base] !== "failed";
      map.setMaxZoom(vector ? 22 : RASTER_MAX_ZOOM[base] + 1);
      map.setPaintProperty("tracks-casing", "line-color", base === "dark" ? "#000000" : "#ffffff");
    };
    whenReady((map) => {
      apply(map, baseLayer);
      const url = VECTOR_STYLES[baseLayer];
      if (!url || vectorState.current[baseLayer]) return;
      vectorState.current[baseLayer] = "loading";
      const id = baseLayer;
      addVectorBase(map, id, url)
        .catch((e) => {
          console.warn("Vektör altlık yüklenemedi, raster yedek kullanılıyor:", e);
          return false;
        })
        .then((ok) => {
          vectorState.current[id] = ok ? "ok" : "failed";
          // Bu arada harita kapatılmadıysa güncel altlığa göre yeniden uygula.
          if (mapRef.current === map) apply(map, live.current.baseLayer);
        });
    });
  }, [baseLayer]);

  return <div ref={container} className="map" />;
});
