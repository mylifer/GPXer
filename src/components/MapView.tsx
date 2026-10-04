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
import { useAreaSelect, useBaseLayerSwitch, useDetailLayers, useCustomLayers, useEditPoint, useRegionLayers, useRoutePins, useTerrain, useTrackLayers } from "../map/useMapLayers";
import { usePhotoMarkers } from "../map/usePhotoMarkers";
import { MapContextMenu } from "../map/MapContextMenu";
import { recordTrip, type VideoOptions } from "../map/video";
import type { Detail } from "../api";

export { BASE_LAYERS, type BaseLayer } from "../map/style";
export { metricDomain } from "../map/geojson";

maplibregl.setWorkerUrl(workerUrl);

export interface MapHandle {
  fitFiles(files: FileEntry[]): void;
  fitPoints(lonLat: [number, number][]): void;
  /** Haritanın görüntüsünü PNG olarak (base64, önek olmadan) verir. */
  exportPng(): Promise<string>;
  /** Noktayı ortaya alır (gerekirse yakınlaştırır). */
  centerOn(lonLat: [number, number], minZoom?: number): void;
  /** Kaydı baştan sona çizerek video kaydeder. */
  recordVideo(d: Detail, o: Omit<VideoOptions, "padding">): Promise<Blob>;
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

  useImperativeHandle(ref, () => ({
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
    recordVideo(d, o) {
      const map = mapRef.current;
      if (!map || !readyRef.current) return Promise.reject(new Error("Harita hazır değil"));
      return recordTrip(map, d, { ...o, padding: padding(60) });
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
      />
    </>
  );
});
