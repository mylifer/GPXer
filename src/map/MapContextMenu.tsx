import { useEffect, useRef, useState } from "react";
import type * as maplibregl from "maplibre-gl";
import { fmtLatLon, fmtLatLonDms } from "../format";

interface Spot {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

/** Panoya yazar; izin verilmeyen ortamda (eski WebView) seçip kopyalar. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // aşağıdaki yedek yola düşer
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("Panoya yazılamadı");
}

/** Haritada sağ tıklanan yerin koordinatlarını kopyalama menüsü. */
export function MapContextMenu({ map, onInfo }: { map: maplibregl.Map | null; onInfo(msg: string): void }) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!map) return;
    // Sağ tuşla sürükleyip döndürmenin sonunda menü açılmasın.
    let down: { x: number; y: number } | null = null;
    const onDown = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.button === 2) down = { x: e.point.x, y: e.point.y };
    };
    const onMenu = (e: maplibregl.MapMouseEvent) => {
      e.preventDefault();
      e.originalEvent.preventDefault();
      if (down && Math.hypot(e.point.x - down.x, e.point.y - down.y) > 5) {
        down = null;
        return;
      }
      down = null;
      setSpot({ x: e.point.x, y: e.point.y, lat: e.lngLat.lat, lon: e.lngLat.wrap().lng });
    };
    const close = () => setSpot(null);
    map.on("mousedown", onDown);
    map.on("contextmenu", onMenu);
    map.on("movestart", close);
    map.on("click", close);
    return () => {
      map.off("mousedown", onDown);
      map.off("contextmenu", onMenu);
      map.off("movestart", close);
      map.off("click", close);
    };
  }, [map]);

  useEffect(() => {
    if (!spot) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSpot(null);
    const onDoc = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node)) setSpot(null);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [spot]);

  if (!spot) return null;
  const dec = fmtLatLon(spot.lat, spot.lon);
  const items: [string, string][] = [
    [dec, dec],
    [fmtLatLonDms(spot.lat, spot.lon), fmtLatLonDms(spot.lat, spot.lon)],
    ["Google Haritalar bağlantısı", `https://www.google.com/maps?q=${spot.lat.toFixed(6)},${spot.lon.toFixed(6)}`],
  ];
  const copy = async (text: string) => {
    setSpot(null);
    try {
      await copyText(text);
      onInfo(`Kopyalandı: ${text}`);
    } catch (e) {
      onInfo(String(e));
    }
  };
  // Menü harita kenarından taşmasın.
  const box = map?.getContainer().getBoundingClientRect();
  const left = Math.min(spot.x, (box?.width ?? 1e4) - 270);
  const top = Math.min(spot.y, (box?.height ?? 1e4) - 130);
  return (
    <div ref={menu} className="map-menu" style={{ left: Math.max(0, left), top: Math.max(0, top) }} role="menu">
      <div className="map-menu-title">Koordinatı kopyala</div>
      {items.map(([label, text]) => (
        <button key={label} role="menuitem" onClick={() => copy(text)}>
          {label}
        </button>
      ))}
    </div>
  );
}
