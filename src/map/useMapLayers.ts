/** MapView'in veri ve görünüm efektleri: her biri değiştiğinde haritadaki
 * kaynakları/katmanları günceller (harita hazır değilse hazır olunca). */
import { useEffect, useRef, type RefObject } from "react";
import type * as maplibregl from "maplibre-gl";
import * as maplibreglNs from "maplibre-gl";
import type { Bookmark, Detail, NamedPlace } from "../api";
import type { FileEntry } from "../types";
import { SEQ_DARK, SEQ_LIGHT } from "../types";
import type { TrackColorBy } from "../prefs";
import type { BBox } from "../geo";
import type { Flight } from "../flights";
import { runWhenReady, setData, type MapRefs } from "./context";
import type { RegionData } from "../hooks/useRegions";
import { tileUrl, type CustomLayer } from "../customLayers";
import { dayIn } from "../days";
import { fastDayKey } from "../format";
import {
  EMPTY,
  areaGeoJSON,
  coloredGeoJSON,
  flightsGeoJSON,
  gapsGeoJSON,
  heatGeoJSON,
  heatStep,
  hotspotsGeoJSON,
  metricDomain,
  rangeGeoJSON,
  stopsGeoJSON,
  tracksGeoJSON,
  waypointsGeoJSON,
  type DateWindow,
} from "./geojson";
import { RASTER_MAX_ZOOM, VECTOR_STYLES, addVectorBase, type BaseLayer } from "./style";

/** İzler, ısı haritası, seçim vurgusu, duraklamalar, uçuşlar ve alan. */
export function useTrackLayers(
  r: MapRefs,
  {
    files,
    pool,
    selected,
    win,
    heatmap,
    dark,
    showGaps,
    highlight,
    places,
    stopsLayer,
    flights,
    area,
  }: {
    files: FileEntry[];
    pool: FileEntry[];
    selected: string | null;
    win: DateWindow | null;
    heatmap: boolean;
    dark: boolean;
    showGaps: boolean;
    highlight: string[] | null;
    places: NamedPlace[];
    stopsLayer: boolean;
    flights: Flight[] | null;
    area: BBox | null;
  },
) {
  const { live, hoverPopup, chooser, chooserPaths, hoverPath, mapHovering } = r;
  const whenReady = (fn: (map: maplibregl.Map) => void) => runWhenReady(r, fn);
  // İz verisi tüm kütüphaneden kurulur; yalnızca kayıtlar, renkler ya da tarih
  // penceresi değişince yeniden gönderilir. Filtre ve görünürlük değişince
  // gösterilmeyen izler katman süzgeciyle gizlenir (süzgeci haritanın işçisi
  // uygular): binlerce kayıtta her tuşta milyonlarca noktayı yeniden göndermek
  // arayüzü donduruyordu.
  const sentData = useRef<{ list: [FileEntry["summary"], string][]; win: DateWindow | null } | null>(null);
  const hiddenPaths = useRef<string[]>([]);
  const highlightRef = useRef<string[]>([]);
  /** İz katmanlarının süzgeçleri: gizlenenler dışarıda, seçili katmanlarda yalnızca seçilenler. */
  const applyFilters = (map: maplibregl.Map) => {
    const hidden = hiddenPaths.current;
    // `match` etiketleri sözlükle arar: on binlerce yolda da hızlı.
    const visible: maplibregl.FilterSpecification = hidden.length ? ["match", ["get", "path"], hidden, false, true] : ["has", "path"];
    const sel: maplibregl.FilterSpecification = ["in", ["get", "path"], ["literal", highlightRef.current]];
    for (const id of ["tracks", "tracks-casing", "waypoints"]) map.setFilter(id, visible);
    map.setFilter("tracks-selected", ["all", sel, visible]);
    map.setFilter("tracks-selected-casing", ["all", sel, visible]);
    // Boşluklar yalnızca seçili (ya da karşılaştırılan) kayıtta çizilir.
    map.setFilter("gaps", ["all", sel, visible]);
  };
  useEffect(() => {
    whenReady((map) => {
      const prev = sentData.current;
      const same =
        prev &&
        prev.win === win &&
        prev.list.length === pool.length &&
        pool.every((f, i) => prev.list[i][0] === f.summary && prev.list[i][1] === f.color);
      if (!same) {
        sentData.current = { list: pool.map((f) => [f.summary, f.color]), win };
        setData(map, "tracks", tracksGeoJSON(pool, win));
        setData(map, "gaps", gapsGeoJSON(pool, win));
        setData(map, "waypoints", waypointsGeoJSON(pool));
      }
      const shown = new Set(files.map((f) => f.summary.path));
      const hidden: string[] = [];
      for (const f of pool) if (!shown.has(f.summary.path)) hidden.push(f.summary.path);
      const prevHidden = hiddenPaths.current;
      if (same && hidden.length === prevHidden.length && hidden.every((p, i) => p === prevHidden[i])) return;
      hiddenPaths.current = hidden;
      applyFilters(map);
    });
  }, [files, pool, win]); // eslint-disable-line react-hooks/exhaustive-deps

  // İz listesi ya da seçim değişince eski bilgi kutusu ekranda kalmasın (sonraki
  // fare hareketinde yeniden açılır); kaybolan izi gösteren seçim penceresi kapanır.
  useEffect(() => {
    const present = new Set(files.map((f) => f.summary.path));
    hoverPopup.current?.remove();
    if (mapHovering.current && (!selected || !present.has(selected) || hoverPath.current !== selected)) {
      mapHovering.current = false;
      live.current.onHoverIdx(null);
    }
    hoverPath.current = null;
    if (chooser.current?.isOpen() && chooserPaths.current.some((p) => !present.has(p))) {
      chooser.current.remove();
      chooserPaths.current = [];
    }
  }, [files, selected]);

  useEffect(() => {
    whenReady((map) => {
      if (!heatmap) return setData(map, "heat", EMPTY);
      // Seyrek noktalar daha ağır sayılır: görünüm nokta aralığından bağımsız.
      const step = heatStep(files, win);
      map.setPaintProperty("heat", "heatmap-weight", (0.5 * step) / 40);
      setData(map, "heat", heatGeoJSON(files, win, step));
    });
  }, [files, heatmap, win]);
  useEffect(() => {
    whenReady((map) => {
      const vis = (id: string, on: boolean) => map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      vis("heat", heatmap);
      vis("tracks", !heatmap);
      vis("tracks-casing", !heatmap);
      vis("gaps", !heatmap && showGaps);
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
  }, [heatmap, dark, showGaps]);

  const highlightKey = (highlight ?? (selected ? [selected] : [])).join("\n");
  useEffect(() => {
    whenReady((map) => {
      const paths = highlightKey ? highlightKey.split("\n") : [];
      highlightRef.current = paths;
      applyFilters(map);
      map.setPaintProperty("tracks", "line-opacity", paths.length ? 0.45 : 0.85);
      map.setPaintProperty("tracks-casing", "line-opacity", paths.length ? 0.4 : 0.9);
    });
  }, [highlightKey]);

  // Seçili kaydın duraklamaları ve sık durulan yerler.
  useEffect(() => {
    whenReady((map) => setData(map, "stops", stopsGeoJSON(files.find((f) => f.summary.path === selected), win, places)));
  }, [files, selected, win, places]);
  useEffect(() => {
    whenReady((map) => {
      map.setLayoutProperty("hotspots", "visibility", stopsLayer ? "visible" : "none");
      setData(map, "hotspots", stopsLayer ? hotspotsGeoJSON(files, places) : EMPTY);
    });
  }, [files, stopsLayer, places]);

  // Uçuş yayları (renk iz renginden).
  useEffect(() => {
    whenReady((map) => {
      const color = new Map(files.map((f) => [f.summary.path, f.color]));
      const on = !!flights && !heatmap;
      map.setLayoutProperty("flights", "visibility", on ? "visible" : "none");
      map.setLayoutProperty("flights-casing", "visibility", on ? "visible" : "none");
      setData(map, "flights", on ? flightsGeoJSON(flights, (p) => color.get(p) ?? "#3c78d8") : EMPTY);
    });
  }, [flights, files, heatmap]);
  useEffect(() => {
    whenReady((map) => setData(map, "area", areaGeoJSON(area)));
  }, [area]);
}

// Alan seçme: sürüklerken dikdörtgen gösterilir, bırakınca alan bildirilir.
export function useAreaSelect(r: MapRefs, areaMode: boolean, box: RefObject<HTMLDivElement | null>) {
  const { mapRef, live } = r;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !areaMode) return;
    const canvas = map.getCanvasContainer();
    map.dragPan.disable();
    map.boxZoom.disable();
    canvas.style.cursor = "crosshair";
    let start: { x: number; y: number } | null = null;
    const rect = () => canvas.getBoundingClientRect();
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const r = rect();
      start = { x: e.clientX - r.left, y: e.clientY - r.top };
      e.preventDefault();
    };
    const move = (e: MouseEvent) => {
      if (!start || !box.current) return;
      const r = rect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      Object.assign(box.current.style, {
        display: "block",
        left: `${Math.min(x, start.x)}px`,
        top: `${Math.min(y, start.y)}px`,
        width: `${Math.abs(x - start.x)}px`,
        height: `${Math.abs(y - start.y)}px`,
      });
    };
    const upH = (e: MouseEvent) => {
      if (!start) return;
      const r = rect();
      const end = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (box.current) box.current.style.display = "none";
      const s0 = start;
      start = null;
      if (Math.abs(end.x - s0.x) < 5 || Math.abs(end.y - s0.y) < 5) return;
      const a = map.unproject([s0.x, s0.y]);
      const b = map.unproject([end.x, end.y]);
      live.current.onArea([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]);
    };
    canvas.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", upH);
    return () => {
      canvas.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", upH);
      canvas.style.cursor = "";
      map.dragPan.enable();
      map.boxZoom.enable();
      if (box.current) box.current.style.display = "none";
    };
  }, [areaMode]);
}

/** Seçili kaydın ölçüye göre renklendirilmesi, seçilen aralık ve imleç(ler). */
export function useDetailLayers(
  r: MapRefs,
  {
    detail,
    trackColorBy,
    dark,
    range,
    hoverIdx,
    followCursor,
    cursors,
    win,
    zone,
  }: {
    detail: Detail | null;
    trackColorBy: TrackColorBy;
    dark: boolean;
    range: [number, number] | null;
    hoverIdx: number | null;
    followCursor: boolean;
    cursors: { lon: number; lat: number; color: string }[];
    /** Tarih filtresi ve seçili kaydın saat dilimi: renklendirme aralık dışını çizmez. */
    win: DateWindow | null;
    zone: string | undefined;
  },
) {
  const whenReady = (fn: (map: maplibregl.Map) => void) => runWhenReady(r, fn);
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
      const inWin = win
        ? (t: number | null) => t == null || dayIn(fastDayKey(t, zone), win.from, win.to)
        : undefined;
      setData(map, "colored", coloredGeoJSON(detail, values, domain, dark ? SEQ_DARK : SEQ_LIGHT, inWin));
    });
  }, [detail, trackColorBy, dark, win, zone]);

  useEffect(() => {
    whenReady((map) => {
      if (!detail || !range) return setData(map, "range", EMPTY);
      setData(map, "range", rangeGeoJSON(detail, range));
    });
  }, [detail, range]);

  useEffect(() => {
    whenReady((map) => {
      const has = detail && hoverIdx != null && hoverIdx < detail.lat.length;
      const pt: [number, number] | null = has ? [detail!.lon[hoverIdx!], detail!.lat[hoverIdx!]] : null;
      const features: GeoJSON.Feature[] = cursors.map((c) => ({
        type: "Feature",
        properties: { color: c.color },
        geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      }));
      if (pt) features.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: pt } });
      setData(map, "cursor", { type: "FeatureCollection", features });
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
  }, [detail, hoverIdx, followCursor, cursors]);
}

/** Altlık değiştirme; Sade/Koyu için vektör stil ilk seçilişte yüklenir. */
export function useBaseLayerSwitch(
  r: MapRefs,
  baseLayer: BaseLayer,
  vectorState: RefObject<Partial<Record<BaseLayer, "loading" | "ok" | "failed">>>,
) {
  const { mapRef, live } = r;
  const whenReady = (fn: (map: maplibregl.Map) => void) => runWhenReady(r, fn);
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
}

/** Gezilen il ve ülke dolguları (kapalıyken null). */
export function useRegionLayers(r: MapRefs, regions: RegionData | null) {
  useEffect(() => {
    runWhenReady(r, (map) => {
      const on = !!regions;
      for (const id of ["regions-countries", "regions-provinces", "regions-provinces-line"])
        map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
      setData(map, "regions-countries", regions?.countries ?? EMPTY);
      setData(map, "regions-provinces", regions?.provinces ?? EMPTY);
    });
  }, [regions]);
}

/** Arazi yükseklik karoları (AWS açık veri, Terrarium kodlaması; anahtar gerektirmez). */
const DEM_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/** 3B arazi: yükseklik kaynağı, kabartma gölgesi ve eğik bakış. */
export function useTerrain(r: MapRefs, on: boolean) {
  useEffect(() => {
    runWhenReady(r, (map) => {
      if (on && !map.getSource("dem")) {
        const dem = {
          type: "raster-dem" as const,
          tiles: [DEM_TILES],
          encoding: "terrarium" as const,
          tileSize: 256,
          maxzoom: 15,
          attribution: "Arazi: Mapzen/AWS Terrain Tiles",
        };
        map.addSource("dem", dem);
        // Gölgeleme ayrı kaynaktan (aynı kaynak hem arazi hem gölge için önerilmiyor).
        map.addSource("dem-shade", dem);
        // İzlerin altına, altlığın üstüne.
        const below = map.getLayer("regions-countries") ? "regions-countries" : undefined;
        map.addLayer(
          {
            id: "hillshade",
            type: "hillshade",
            source: "dem-shade",
            paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#3d3d3d" },
          },
          below,
        );
      }
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", on ? "visible" : "none");
      if (on) {
        map.setTerrain({ source: "dem", exaggeration: 1.4 });
        map.easeTo({ pitch: Math.max(map.getPitch(), 60), duration: 800 });
      } else if (map.getTerrain()) {
        map.setTerrain(null);
        map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
      }
    });
  }, [on]);
}

/** Güzergâh aramasının A ve B noktaları (işaretçi). */
export function useRoutePins(map: maplibregl.Map | null, pins: { a: [number, number] | null; b: [number, number] | null }) {
  const { a, b } = pins;
  useEffect(() => {
    if (!map) return;
    const made: maplibregl.Marker[] = [];
    for (const [label, p] of [
      ["A", a],
      ["B", b],
    ] as const) {
      if (!p) continue;
      const el = document.createElement("div");
      el.className = `route-pin route-pin-${label.toLowerCase()}`;
      el.textContent = label;
      made.push(new maplibreglNs.Marker({ element: el }).setLngLat(p).addTo(map));
    }
    return () => made.forEach((m) => m.remove());
  }, [map, a?.[0], a?.[1], b?.[0], b?.[1]]);
}

/** Nokta düzenleme: izin noktasına tıklanınca seçilir, sürüklenebilir işaretçi
 * olarak gösterilir; bırakılınca yeni konum bildirilir. */
export function useEditPoint(
  map: maplibregl.Map | null,
  edit: { detail: Detail; idx: number | null } | null,
  onPick: (i: number) => void,
  onMove: (i: number, lonLat: [number, number]) => void,
) {
  const detail = edit?.detail ?? null;
  const idx = edit?.idx ?? null;
  // Tıklanan yere en yakın örnek (ekranda 14 px içinde).
  useEffect(() => {
    if (!map || !detail) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = "crosshair";
    const click = (e: maplibregl.MapMouseEvent) => {
      let best = -1;
      let bestD = 14 * 14;
      for (let i = 0; i < detail.lat.length; i++) {
        const p = map.project([detail.lon[i], detail.lat[i]]);
        const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best >= 0) onPick(best);
    };
    map.on("click", click);
    return () => {
      map.off("click", click);
      canvas.style.cursor = "";
    };
  }, [map, detail]);
  useEffect(() => {
    if (!map || !detail || idx == null || idx >= detail.lat.length) return;
    const el = document.createElement("div");
    el.className = "edit-pin";
    el.title = "Sürükleyerek taşıyın";
    const m = new maplibreglNs.Marker({ element: el, draggable: true }).setLngLat([detail.lon[idx], detail.lat[idx]]).addTo(map);
    m.on("dragend", () => {
      const ll = m.getLngLat();
      onMove(idx, [ll.lng, ll.lat]);
    });
    return () => {
      m.remove();
    };
  }, [map, detail, idx]);
}

/** Kullanıcının eklediği raster katmanlar: altlığın üstünde, izlerin altında. */
export function useCustomLayers(r: MapRefs, layers: CustomLayer[]) {
  const key = JSON.stringify(layers);
  useEffect(() => {
    runWhenReady(r, (map) => {
      const want = new Map(layers.map((l) => [`custom-${l.id}`, l]));
      // Kaldırılan ya da adresi değişen katmanlar silinir.
      for (const { id } of map.getStyle().layers) {
        if (!id.startsWith("custom-")) continue;
        const l = want.get(id);
        const src = map.getSource(id) as maplibregl.RasterTileSource | undefined;
        if (!l || (src && src.tiles?.[0] !== tileUrl(l.url))) {
          map.removeLayer(id);
          if (map.getSource(id)) map.removeSource(id);
        }
      }
      const before = ["hillshade", "regions-countries", "heat"].find((x) => map.getLayer(x));
      for (const [id, l] of want) {
        if (!map.getSource(id)) {
          map.addSource(id, { type: "raster", tiles: [tileUrl(l.url)], tileSize: 256, attribution: l.name });
          map.addLayer({ id, type: "raster", source: id }, before);
        }
        map.setLayoutProperty(id, "visibility", l.on ? "visible" : "none");
        map.setPaintProperty(id, "raster-opacity", Math.max(0.05, Math.min(1, l.opacity)));
      }
    });
  }, [key]);
}

/** Yer imleri (işaretçi; tıklayınca düzenleme). */
export function useBookmarkMarkers(map: maplibregl.Map | null, marks: Bookmark[] | null, onClick: (b: Bookmark) => void) {
  const key = JSON.stringify(marks?.map((m) => [m.id, m.lat, m.lon, m.name, m.wish]) ?? null);
  useEffect(() => {
    if (!map || !marks) return;
    const made = marks.map((b) => {
      const el = document.createElement("div");
      el.className = "bookmark-pin";
      el.textContent = b.wish ? "⭐" : "📌";
      el.title = b.note ? `${b.name}\n${b.note}` : b.name;
      el.dataset.noI18n = "";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        onClick(b);
      });
      return new maplibreglNs.Marker({ element: el, anchor: "bottom" }).setLngLat([b.lon, b.lat]).addTo(map);
    });
    return () => made.forEach((m) => m.remove());
  }, [map, key]);
}

/** Keşif kareleri katmanı (kapalıyken null). */
export function useExplorerLayer(r: MapRefs, data: GeoJSON.FeatureCollection | null) {
  useEffect(() => {
    runWhenReady(r, (map) => {
      for (const id of ["explorer", "explorer-square"]) map.setLayoutProperty(id, "visibility", data ? "visible" : "none");
      setData(map, "explorer", data ?? EMPTY);
    });
  }, [data]);
}

export interface PlanView {
  points: [number, number][];
  /** Yola oturtulmuş rota [boylam, enlem]; hesaplanmadıysa düz çizgi çizilir. */
  line: [number, number][] | null;
}

/** Rota planlama: haritaya tıklayınca nokta eklenir; numaralı işaretçiler
 * sürüklenebilir, sağ tıkla silinir. */
export function usePlanLayer(
  r: MapRefs,
  map: maplibregl.Map | null,
  plan: PlanView | null,
  cb: { add(p: [number, number]): void; move(i: number, p: [number, number]): void; remove(i: number): void },
) {
  const on = !!plan;
  useEffect(() => {
    if (!map || !on) return;
    map.getCanvas().style.cursor = "crosshair";
    const click = (e: maplibregl.MapMouseEvent) => cb.add([e.lngLat.lng, e.lngLat.lat]);
    map.on("click", click);
    return () => {
      map.off("click", click);
      map.getCanvas().style.cursor = "";
    };
  }, [map, on]);
  const key = JSON.stringify(plan?.points ?? null);
  useEffect(() => {
    if (!map || !plan) return;
    const made = plan.points.map((p, i) => {
      const el = document.createElement("div");
      el.className = "plan-pin";
      el.textContent = String(i + 1);
      el.title = "Sürükleyerek taşıyın, sağ tıklayarak silin";
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        cb.remove(i);
      });
      el.addEventListener("click", (e) => e.stopPropagation());
      const m = new maplibreglNs.Marker({ element: el, draggable: true }).setLngLat(p).addTo(map);
      m.on("dragend", () => {
        const ll = m.getLngLat();
        cb.move(i, [ll.lng, ll.lat]);
      });
      return m;
    });
    return () => made.forEach((m) => m.remove());
  }, [map, key]);
  const lineKey = JSON.stringify(plan?.line ?? plan?.points ?? null);
  useEffect(() => {
    runWhenReady(r, (m) => {
      const coords = plan ? (plan.line ?? plan.points) : [];
      setData(m, "plan", coords.length >= 2 ? { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } : EMPTY);
    });
  }, [lineKey]);
}
