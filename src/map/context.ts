import type { RefObject } from "react";
import type * as maplibregl from "maplibre-gl";
import type { GeoJSONSource } from "maplibre-gl";
import type { Detail, FileSummary, NamedPlace } from "../api";
import type { FileEntry } from "../types";
import type { TrackColorBy } from "../prefs";
import type { BBox } from "../geo";
import type { Flight } from "../flights";
import type { PlacedPhoto } from "../photos";
import type { BaseLayer } from "./style";
import type { DateWindow } from "./geojson";

export interface MapViewState {
  center: [number, number];
  zoom: number;
}

export interface MapViewProps {
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
  /** Alan seçme kipi: sürükleyerek dikdörtgen çizilir. */
  areaMode: boolean;
  area: BBox | null;
  onArea(b: BBox | null): void;
  /** Tüm kayıtlarda sık durulan yerler. */
  stopsLayer: boolean;
  /** Seçili kayıtta kayıt boşlukları (kesik çizgi). */
  showGaps: boolean;
  /** Karşılaştırmada vurgulanan izler (seçimin yerine). */
  highlight: string[] | null;
  /** Ek imleçler (karşılaştırma). */
  cursors: { lon: number; lat: number; color: string }[];
  /** Tarih filtresi (yoksa null): kayıtların yalnızca bu günlere düşen kısmı çizilir. */
  dateWindow: DateWindow | null;
  /** Adlandırılmış yerler (duraklama kutularında ad). */
  places: NamedPlace[];
  /** Duraklamaya / sık durulan yere ad verme (yer zaten adlıysa o yer). */
  onNamePlace(lon: number, lat: number, place: NamedPlace | null): void;
  /** Gösterilen kayıtların uçuşları; katman kapalıysa null. */
  flights: Flight[] | null;
  onFlight(f: Flight): void;
  /** Haritadaki fotoğraflar; katman kapalıysa null. */
  photos: PlacedPhoto[] | null;
  /** Fotoğrafın eşleştiği kaydın özeti (ad ve saat dilimi için). */
  summaryOf(path: string): FileSummary | undefined;
  onPhotoRecord(path: string): void;
}

/** MapView'in harita, bilgi kutusu ve fare durumu için paylaştığı ref'ler;
 * efektler ve olay işleyicileri bunları her zaman güncel okur. */
export interface MapRefs {
  mapRef: RefObject<maplibregl.Map | null>;
  readyRef: RefObject<boolean>;
  /** Harita yüklenmeden önce gelen güncellemeler. */
  pendingRef: RefObject<((map: maplibregl.Map) => void)[]>;
  /** Olay işleyicileri her zaman güncel değerleri görsün. */
  live: RefObject<MapViewProps>;
  hoverPopup: RefObject<maplibregl.Popup | null>;
  chooser: RefObject<maplibregl.Popup | null>;
  /** Seçim penceresinde listelenen izler. */
  chooserPaths: RefObject<string[]>;
  /** Üzerinde bilgi kutusu açık olan iz (duraklama/boşluk kutusunda null). */
  hoverPath: RefObject<string | null>;
  moveFrame: RefObject<number>;
  moveEvent: RefObject<maplibregl.MapMouseEvent | null>;
  /** İmleç konumunu şu an harita mı belirliyor. */
  mapHovering: RefObject<boolean>;
}

/** Harita hazır olduğunda ya da hemen: bir efekt işini çalıştırır. */
export function runWhenReady(r: MapRefs, fn: (map: maplibregl.Map) => void) {
  const map = r.mapRef.current;
  if (!map) return;
  if (r.readyRef.current) fn(map);
  else r.pendingRef.current.push(fn);
}

export const setData = (map: maplibregl.Map, id: string, data: GeoJSON.GeoJSON) =>
  (map.getSource(id) as GeoJSONSource).setData(data);
