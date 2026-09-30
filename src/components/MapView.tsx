import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import { type GeoJSONSource, type LngLatBoundsLike, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre worker'ı kendi yanında arar; bu Vite paketinde ve tauri:// adresinde
// çalışmadığı için worker'ı Vite'a ayrı parça olarak paketletip adresini veriyoruz.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FileSummary } from "../api";
import type { FileEntry } from "../types";
import { fmtDate, fmtDistance, fmtTimestamp } from "../format";

maplibregl.setWorkerUrl(workerUrl);

export type BaseLayer = "light" | "dark" | "osm" | "topo" | "satellite";

export const BASE_LAYERS: { id: BaseLayer; label: string }[] = [
  { id: "light", label: "Sade" },
  { id: "dark", label: "Koyu" },
  { id: "osm", label: "Sokak" },
  { id: "topo", label: "Topoğrafik" },
  { id: "satellite", label: "Uydu" },
];

export interface MapHandle {
  fitFiles(files: FileEntry[]): void;
}

interface Props {
  files: FileEntry[];
  selected: string | null;
  cursor: [number, number] | null;
  baseLayer: BaseLayer;
  onSelect(path: string | null): void;
}

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    // Soluk renkli, az ayrıntılı altlıklar: izler üzerinde belirgin durur.
    light: {
      type: "raster",
      tiles: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png`),
      tileSize: 256,
      maxzoom: 20,
      attribution: '© <a href="https://carto.com/attributions">CARTO</a>, © OpenStreetMap katkıcıları',
    },
    dark: {
      type: "raster",
      tiles: ["a", "b", "c", "d"].map((s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`),
      tileSize: 256,
      maxzoom: 20,
      attribution: '© <a href="https://carto.com/attributions">CARTO</a>, © OpenStreetMap katkıcıları',
    },
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
    { id: "base-dark", type: "raster", source: "dark", layout: { visibility: "none" } },
    { id: "base-osm", type: "raster", source: "osm", layout: { visibility: "none" } },
    { id: "base-topo", type: "raster", source: "topo", layout: { visibility: "none" } },
    { id: "base-satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
  ],
};

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

export function boundsOf(files: FileEntry[]): LngLatBoundsLike | null {
  let b: [number, number, number, number] | null = null;
  for (const f of files) {
    const x = f.summary.stats.bbox;
    if (!x) continue;
    b = b ? [Math.min(b[0], x[0]), Math.min(b[1], x[1]), Math.max(b[2], x[2]), Math.max(b[3], x[3])] : [...x];
  }
  return b ? [[b[0], b[1]], [b[2], b[3]]] : null;
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
  return bestT < 0.5 ? ta ?? tb : tb ?? ta;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export const MapView = forwardRef<MapHandle, Props>(function MapView(
  { files, selected, cursor, baseLayer, onSelect },
  ref,
) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  /** Harita yüklenmeden önce gelen güncellemeler. */
  const pendingRef = useRef<((map: maplibregl.Map) => void)[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const hoverPopup = useRef<maplibregl.Popup | null>(null);

  useImperativeHandle(ref, () => ({
    fitFiles(list) {
      const map = mapRef.current;
      const b = boundsOf(list);
      if (!map || !b) return;
      map.fitBounds(b, { padding: 60, maxZoom: 16, duration: 600 });
    },
  }));

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: STYLE,
      center: [35, 39],
      zoom: 5,
      attributionControl: { compact: true },
      // Kutu yakınlaştırmayı Shift ile, döndürmeyi sağ tuşla yapmak için varsayılanlar yeterli.
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");

    map.on("load", () => {
      map.addSource("tracks", { type: "geojson", data: EMPTY, tolerance: 0.2 });
      map.addSource("waypoints", { type: "geojson", data: EMPTY });
      map.addSource("cursor", { type: "geojson", data: EMPTY });

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

      // Çizgiler ince olduğu için tıklamayı birkaç piksellik kutuyla yakalıyoruz.
      const hitTracks = (p: maplibregl.Point) =>
        map.queryRenderedFeatures(
          [
            [p.x - 5, p.y - 5],
            [p.x + 5, p.y + 5],
          ],
          { layers: ["tracks"] },
        );

      map.on("click", (e) => {
        const wp = map.queryRenderedFeatures(e.point, { layers: ["waypoints"] })[0];
        if (wp) {
          const name = String(wp.properties?.name || "Nokta");
          new maplibregl.Popup({ closeButton: false })
            .setLngLat((wp.geometry as GeoJSON.Point).coordinates as [number, number])
            .setHTML(`<strong>${escapeHtml(name)}</strong>`)
            .addTo(map);
          return;
        }
        const hit = hitTracks(e.point)[0];
        onSelectRef.current(hit ? String(hit.properties?.path) : null);
      });

      map.on("mousemove", (e) => {
        const hit = hitTracks(e.point)[0] ?? map.queryRenderedFeatures(e.point, { layers: ["waypoints"] })[0];
        map.getCanvas().style.cursor = hit ? "pointer" : "";
        const path = hit?.layer.id === "tracks" ? String(hit.properties?.path) : null;
        const entry = path ? filesRef.current.find((f) => f.summary.path === path) : null;
        if (!entry) {
          hoverPopup.current?.remove();
          return;
        }
        const s = entry.summary;
        const t = timeAt(s, e.lngLat.lng, e.lngLat.lat);
        const html =
          `<strong>${escapeHtml(s.name || s.fileName)}</strong><br>` +
          (t != null
            ? `<span class="popup-time">${fmtTimestamp(t)}</span><br>${fmtDistance(s.stats.distanceM)}`
            : `${fmtDate(s.stats.startTime)} · ${fmtDistance(s.stats.distanceM)}`);
        if (!hoverPopup.current) {
          hoverPopup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 12, className: "hover-popup" });
        }
        hoverPopup.current.setLngLat(e.lngLat).setHTML(html).addTo(map);
      });
      map.on("mouseout", () => hoverPopup.current?.remove());

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

  useEffect(() => {
    whenReady((map) => {
      (map.getSource("tracks") as GeoJSONSource).setData(tracksGeoJSON(files));
      (map.getSource("waypoints") as GeoJSONSource).setData(waypointsGeoJSON(files));
    });
  }, [files]);

  useEffect(() => {
    whenReady((map) => {
      const f: maplibregl.FilterSpecification = ["==", ["get", "path"], selected ?? ""];
      map.setFilter("tracks-selected", f);
      map.setFilter("tracks-selected-casing", f);
      map.setPaintProperty("tracks", "line-opacity", selected ? 0.45 : 0.85);
      map.setPaintProperty("tracks-casing", "line-opacity", selected ? 0.4 : 0.9);
    });
  }, [selected]);

  useEffect(() => {
    whenReady((map) => {
      (map.getSource("cursor") as GeoJSONSource).setData(
        cursor
          ? { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: cursor } }
          : EMPTY,
      );
    });
  }, [cursor]);

  useEffect(() => {
    whenReady((map) => {
      for (const l of BASE_LAYERS) {
        map.setLayoutProperty(`base-${l.id}`, "visibility", l.id === baseLayer ? "visible" : "none");
      }
      map.setPaintProperty("tracks-casing", "line-color", baseLayer === "dark" ? "#000000" : "#ffffff");
    });
  }, [baseLayer]);

  return <div ref={container} className="map" />;
});
