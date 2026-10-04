import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
// MapLibre worker'ı kendi yanında arar; bu Vite paketinde ve tauri:// adresinde
// çalışmadığı için worker'ı Vite'a ayrı parça olarak paketletip adresini veriyoruz.
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { FileEntry } from "../types";
import { tzOf } from "../format";
import { STYLE, addOverlayLayers, type BaseLayer } from "../map/style";
import { boundsOf, type DateWindow } from "../map/geojson";
import type { MapRefs, MapViewProps } from "../map/context";
import { installInteractions } from "../map/interactions";
import { useAreaSelect, useBaseLayerSwitch, useDetailLayers, useBookmarkMarkers, useCustomLayers, useEditPoint, useExplorerLayer, usePlanLayer, useRegionLayers, useRoutePins, useTerrain, useTrackLayers } from "../map/useMapLayers";
import { usePhotoMarkers } from "../map/usePhotoMarkers";
import { MapContextMenu } from "../map/MapContextMenu";
import { recordTrip, type VideoOptions } from "../map/video";
import { installTileCache, transformRequest, visibleTileUrls } from "../map/offline";
import { maskCanvas } from "../privacy";
import type { Detail } from "../api";

export { BASE_LAYERS, type BaseLayer } from "../map/style";
export { metricDomain } from "../map/geojson";

maplibregl.setWorkerUrl(workerUrl);
installTileCache();

export interface MapHandle {
  fitFiles(files: FileEntry[]): void;
  fitPoints(lonLat: [number, number][]): void;
  /** Haritanın görüntüsünü PNG olarak (base64, önek olmadan) verir. */
  exportPng(): Promise<string>;
  /** Noktayı ortaya alır (gerekirse yakınlaştırır). */
  centerOn(lonLat: [number, number], minZoom?: number): void;
  /** Görünen alanın çevrimdışı için indirilecek karo adresleri. */
  offlineTileUrls(extra: number): { urls: string[]; skipped: string[]; capped: boolean };
  /** Kaydı baştan sona çizerek video kaydeder. */
  recordVideo(d: Detail, o: Omit<VideoOptions, "padding" | "zones">): Promise<Blob>;
  /** Aranan yeri gösterir: kutusu varsa kutuya sığdırır, yoksa yakınlaştırır; geçici işaret koyar. */
  showPlace(p: { lat: number; lon: number; bbox?: [number, number, number, number] | null; zoom: number; label: string }): void;
  /** Haritanın ortası [boylam, enlem]. */
  center(): [number, number] | null;
}

export const MapView = forwardRef<MapHandle, MapViewProps>(function MapView(props, ref) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapObj, setMapObj] = useState<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  /** Harita yüklenmeden önce gelen güncellemeler. */
  const pendingRef = useRef<((map: maplibregl.Map) => void)[]>([]);
  // Olay işleyicileri her zaman güncel değerleri görsün.
  const live = useRef(props);
  live.current = props;
  const hoverPopup = useRef<maplibregl.Popup | null>(null);
  const chooser = useRef<maplibregl.Popup | null>(null);
  /** Seçim penceresinde listelenen izler. */
  const chooserPaths = useRef<string[]>([]);
  /** Üzerinde bilgi kutusu açık olan iz (duraklama/boşluk kutusunda null). */
  const hoverPath = useRef<string | null>(null);
  const moveFrame = useRef(0);
  const moveEvent = useRef<maplibregl.MapMouseEvent | null>(null);
  /** İmleç konumunu şu an harita mı belirliyor. */
  const mapHovering = useRef(false);
  /** Vektör stilleri: yükleniyor / yüklendi / yüklenemedi (raster yedek). */
  const vectorState = useRef<Partial<Record<BaseLayer, "loading" | "ok" | "failed">>>({});

  const {
    files,
    selected,
    detail,
    hoverIdx,
    range,
    trackColorBy,
    heatmap,
    followCursor,
    baseLayer,
    areaMode,
    area,
    stopsLayer,
    showGaps,
    highlight,
    cursors,
    dateWindow,
    places,
    flights,
    photos,
  } = props;
  const winFrom = dateWindow?.from ?? "";
  const winTo = dateWindow?.to ?? "";
  // Nesne her çizimde yeni olabilir: efektler dizgelere bağlı.
  const win = useMemo<DateWindow | null>(() => (winFrom || winTo ? { from: winFrom, to: winTo } : null), [winFrom, winTo]);
  const box = useRef<HTMLDivElement>(null);
  const winRef = useRef(win);
  winRef.current = win;
  const refs: MapRefs = { mapRef, readyRef, pendingRef, live, hoverPopup, chooser, chooserPaths, hoverPath, moveFrame, moveEvent, mapHovering };

  // Üst kenar, birkaç satıra inebilen araç çubuğunun altından başlar.
  // (CSS değişkeni WebKitGTK'da okunamıyordu; çubuk doğrudan ölçülür.)
  const padding = (base: number) => {
    const el = container.current;
    const bar = el?.closest(".map-wrap")?.querySelector(".map-toolbar");
    const below = el && bar ? bar.getBoundingClientRect().bottom - el.getBoundingClientRect().top : NaN;
    return { top: Number.isFinite(below) ? Math.max(base, below + 20) : base, bottom: base, left: base, right: base };
  };

  const searchPin = useRef<maplibregl.Marker | null>(null);
  useImperativeHandle(ref, () => ({
    showPlace({ lat, lon, bbox, zoom, label }) {
      const map = mapRef.current;
      if (!map) return;
      if (bbox && bbox[2] - bbox[0] > 0.002) map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: padding(60), maxZoom: 16, duration: 800 });
      else map.flyTo({ center: [lon, lat], zoom, duration: 800 });
      searchPin.current?.remove();
      const el = document.createElement("div");
      el.className = "search-pin";
      el.title = label;
      el.dataset.noI18n = "";
      searchPin.current = new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([lon, lat]).addTo(map);
    },
    center() {
      const c = mapRef.current?.getCenter();
      return c ? [c.lng, c.lat] : null;
    },
    fitFiles(list) {
      const map = mapRef.current;
      const b = boundsOf(list, winRef.current);
      if (!map || !b) return;
      map.fitBounds(b, { padding: padding(60), maxZoom: 16, duration: 600 });
    },
    fitPoints(pts) {
      const map = mapRef.current;
      if (!map || pts.length === 0) return;
      const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
      for (const p of pts) b.extend(p);
      map.fitBounds(b, { padding: padding(80), maxZoom: 17, duration: 600 });
    },
    centerOn(pt, minZoom = 13) {
      const map = mapRef.current;
      if (!map) return;
      map.easeTo({ center: pt, zoom: Math.max(map.getZoom(), minZoom), duration: 600 });
    },
    offlineTileUrls(extra) {
      const map = mapRef.current;
      return map ? visibleTileUrls(map, extra) : { urls: [], skipped: [], capped: false };
    },
    recordVideo(d, o) {
      const map = mapRef.current;
      if (!map || !readyRef.current) return Promise.reject(new Error("Harita hazır değil"));
      return recordTrip(map, d, { ...o, padding: padding(60), zones: live.current.privacyZones });
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
            // Gizlilik bölgeleri görüntüde örtülür.
            maskCanvas(ctx, (p) => map.project(p), live.current.privacyZones, out.width / (src.clientWidth || out.width));
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
      transformRequest,
    });
    mapRef.current = map;
    setMapObj(map);
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    map.on("moveend", () => {
      const c = map.getCenter();
      live.current.onViewChange({ center: [c.lng, c.lat], zoom: map.getZoom() });
    });

    // "load" altlık parçaları gelene kadar beklediği için (yavaş ya da kopuk
    // bağlantıda hiç gelmeyebilir) izler stil hazır olur olmaz eklenir.
    map.once("style.load", () => {
      addOverlayLayers(map);
      installInteractions(map, refs);

      readyRef.current = true;
      const pending = pendingRef.current;
      pendingRef.current = [];
      pending.forEach((fn) => fn(map));
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(container.current!);
    return () => {
      ro.disconnect();
      if (moveFrame.current) cancelAnimationFrame(moveFrame.current);
      moveFrame.current = 0;
      moveEvent.current = null;
      map.remove();
      mapRef.current = null;
      setMapObj(null);
      readyRef.current = false;
      pendingRef.current = [];
    };
  }, []);

  const dark = baseLayer === "dark" || baseLayer === "satellite";
  useTrackLayers(refs, { files, selected, win, heatmap, dark, showGaps, highlight, places, stopsLayer, flights, area });
  useAreaSelect(refs, areaMode, box);
  const zone = useMemo(() => {
    const f = files.find((x) => x.summary.path === selected);
    return f ? tzOf(f.summary) : undefined;
  }, [files, selected]);
  useDetailLayers(refs, { detail, trackColorBy, dark, range, hoverIdx, followCursor, cursors, win, zone });
  useBaseLayerSwitch(refs, baseLayer, vectorState);
  usePhotoMarkers(refs, photos);
  useRegionLayers(refs, props.regions);
  useTerrain(refs, props.terrain);
  useCustomLayers(refs, props.customLayers);
  useExplorerLayer(refs, props.explorer);
  usePlanLayer(refs, mapObj, props.plan, {
    add: (p) => live.current.onPlanAdd(p),
    move: (i, p) => live.current.onPlanMove(i, p),
    remove: (i) => live.current.onPlanRemove(i),
  });
  useBookmarkMarkers(mapObj, props.bookmarks, (b) => live.current.onBookmark(b));
  useRoutePins(mapObj, props.routePins);
  useEditPoint(
    mapObj,
    props.editing,
    (i) => live.current.onEditPick(i),
    (i, p) => live.current.onEditMove(i, p),
  );

  return (
    <>
      <div ref={container} className="map" />
      <div ref={box} className="area-box" />
      <MapContextMenu
        map={mapObj}
        onInfo={(m) => live.current.onInfo(m)}
        onRoutePoint={(w, p) => live.current.onRoutePoint(w, p)}
        onBookmarkHere={(p) => live.current.onBookmarkHere(p)}
      />
    </>
  );
});
