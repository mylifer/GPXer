/** Haritadaki fare etkileşimleri: tıklama (seçim, duraklamaya ad verme,
 * üst üste binen izlerden seçim) ve üzerine gelince açılan bilgi kutuları. */
import * as maplibregl from "maplibre-gl";
import { streetLine } from "./streetAt";
import { namedPlaceAt } from "../places";
import type { MapRefs } from "./context";
import { nearestDetail, timeAt } from "./geojson";
import {
  chooserItemHtml,
  detailPopupHtml,
  escapeHtml,
  flightPopupHtml,
  gapPopupHtml,
  stopPopupHtml,
  trackPopupHtml,
} from "./popups";

export const hitBox = (p: maplibregl.Point, r = 5): [maplibregl.PointLike, maplibregl.PointLike] => [
  [p.x - r, p.y - r],
  [p.x + r, p.y + r],
];

/** Tıklama ve fare hareketi işleyicilerini kurar (stil yüklenince bir kez). */
export function installInteractions(map: maplibregl.Map, r: MapRefs) {
  const { live, hoverPopup, chooser, chooserPaths, hoverPath, moveFrame, moveEvent, mapHovering, mapRef } = r;
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

  /** Tıklamayla açılan, üzerinde düğme olan kalıcı kutu (seçim penceresiyle aynı yuva). */
  const openSticky = (lngLat: maplibregl.LngLatLike, content: HTMLElement, cls = "chooser-popup") => {
    hoverPopup.current?.remove();
    hoverPath.current = null;
    chooserPaths.current = [];
    chooser.current = new maplibregl.Popup({ closeButton: true, maxWidth: "300px", className: cls })
      .setLngLat(lngLat)
      .setDOMContent(content)
      .addTo(map);
  };

  map.on("click", (e) => {
    if (live.current.areaMode || live.current.editing || live.current.plan) return;
    chooser.current?.remove();
    const spot = map.queryRenderedFeatures(hitBox(e.point, 6), { layers: ["stops", "hotspots"] })[0];
    if (spot) {
      const pr = spot.properties ?? {};
      const [lon, lat] = (spot.geometry as GeoJSON.Point).coordinates as [number, number];
      const place = namedPlaceAt(lon, lat, live.current.places);
      const box = document.createElement("div");
      box.className = "spot-box";
      const info = document.createElement("div");
      info.innerHTML = stopPopupHtml(pr, spot.layer.id === "stops" ? "stop" : "hot");
      const btn = document.createElement("button");
      btn.className = "btn small";
      btn.textContent = place ? `“${place.name}” adını değiştir…` : "Bu yere ad ver…";
      btn.onclick = () => {
        chooser.current?.remove();
        live.current.onNamePlace(lon, lat, place);
      };
      box.append(info, btn);
      openSticky([lon, lat], box);
      return;
    }
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
    if (!hits.length && live.current.flights) {
      const fl = map.queryRenderedFeatures(hitBox(e.point, 5), { layers: ["flights"] })[0];
      const f = fl ? live.current.flights[Number(fl.properties?.i)] : undefined;
      if (f) {
        live.current.onFlight(f);
        return;
      }
    }
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
      const b = document.createElement("button");
      b.innerHTML = chooserItemHtml(f);
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
    hoverPath.current = null;
    chooserPaths.current = hits;
    chooser.current = new maplibregl.Popup({ closeButton: true, maxWidth: "280px", className: "chooser-popup" })
      .setLngLat(e.lngLat)
      .setDOMContent(box)
      .addTo(map);
  });

  /** Son hover kutusunun sırası (geç gelen sokak yanıtı eski kutuyu yazmasın). */
  let hoverToken = 0;
  // Fare hareketi kare başına bir kez işlenir (yalnızca son olay); sorgular pahalı.
  const handleMove = (e: maplibregl.MapMouseEvent) => {
    const { files: fs, selected: sel, detail: d, heatmap: heatOn } = live.current;
    if (live.current.areaMode) {
      // Alan seçerken iz bilgisi gösterilmez; imleç de bırakılır.
      hoverPath.current = null;
      hoverPopup.current?.remove();
      releaseHover();
      return;
    }
    const spot = map.queryRenderedFeatures(hitBox(e.point, 6), { layers: ["stops", "hotspots"] })[0];
    if (spot && !chooser.current?.isOpen()) {
      const pr = spot.properties ?? {};
      const html = `${stopPopupHtml(pr, spot.layer.id === "stops" ? "stop" : "hot")}<br><small class="muted">Ad vermek için tıklayın</small>`;
      if (!hoverPopup.current) {
        hoverPopup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "hover-popup" });
      }
      hoverPath.current = null;
      hoverPopup.current.setLngLat(e.lngLat).setHTML(html).addTo(map);
      map.getCanvas().style.cursor = "default";
      releaseHover();
      return;
    }
    const hits = trackHits(e.point);
    const flts = live.current.flights;
    const fl = hits.length || !flts ? null : map.queryRenderedFeatures(hitBox(e.point, 4), { layers: ["flights"] })[0];
    const flight = fl ? flts![Number(fl.properties?.i)] : undefined;
    if (flight && !chooser.current?.isOpen()) {
      if (!hoverPopup.current) {
        hoverPopup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "hover-popup" });
      }
      hoverPath.current = null;
      hoverPopup.current.setLngLat(e.lngLat).setHTML(flightPopupHtml(flight, live.current.summaryOf(flight.path))).addTo(map);
      map.getCanvas().style.cursor = "pointer";
      releaseHover();
      return;
    }
    const gap = hits.length || heatOn ? null : map.queryRenderedFeatures(hitBox(e.point, 4), { layers: ["gaps"] })[0];
    if (gap && !chooser.current?.isOpen()) {
      if (!hoverPopup.current) {
        hoverPopup.current = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 14, className: "hover-popup" });
      }
      hoverPath.current = null;
      hoverPopup.current.setLngLat(e.lngLat).setHTML(gapPopupHtml(gap.properties ?? {})).addTo(map);
      map.getCanvas().style.cursor = "default";
      releaseHover();
      return;
    }
    const wp = hits.length ? null : map.queryRenderedFeatures(hitBox(e.point, 4), { layers: ["waypoints"] })[0];
    map.getCanvas().style.cursor = hits.length || wp ? "pointer" : "";
    if (chooser.current?.isOpen()) return;
    // Seçili iz imlecin altındaysa ona öncelik verilir.
    const path = sel && hits.includes(sel) ? sel : (hits[0] ?? null);
    const entry = path ? fs.find((f) => f.summary.path === path) : null;
    if (!entry || (heatOn && path !== sel)) {
      hoverPath.current = null;
      hoverPopup.current?.remove();
      releaseHover();
      return;
    }
    const s = entry.summary;
    let html: string;
    // Sokak adı izin üzerindeki noktaya göre (seçili kayıtta en yakın nokta).
    let at: [number, number] = [e.lngLat.lng, e.lngLat.lat];
    if (path === sel && d && d.lat.length) {
      const i = nearestDetail(d, e.lngLat.lng, e.lngLat.lat);
      mapHovering.current = true;
      live.current.onHoverIdx(i);
      html = detailPopupHtml(s, d, i);
      at = [d.lon[i], d.lat[i]];
    } else {
      releaseHover();
      const t = timeAt(s, e.lngLat.lng, e.lngLat.lat);
      html = trackPopupHtml(s, t, hits.length);
    }
    const base = html;
    const lngLat = e.lngLat;
    const token = ++hoverToken;
    html += streetLine(at[0], at[1], () => {
      // Yanıt gelince kutu hâlâ aynı noktadaysa satır eklenir (fare ilerlediyse
      // yeni nokta kendi yanıtını bekler).
      if (token !== hoverToken || hoverPath.current !== path || !hoverPopup.current?.isOpen()) return;
      const line = streetLine(at[0], at[1], () => {});
      if (line) hoverPopup.current.setLngLat(lngLat).setHTML(base + line);
    });
    if (!hoverPopup.current) {
      hoverPopup.current = new maplibregl.Popup({
        closeButton: false,
        closeOnClick: false,
        offset: 14,
        className: "hover-popup",
      });
    }
    hoverPath.current = path;
    hoverPopup.current.setLngLat(e.lngLat).setHTML(html).addTo(map);
  };
  map.on("mousemove", (e) => {
    moveEvent.current = e;
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const ev = moveEvent.current;
      moveEvent.current = null;
      if (ev && mapRef.current === map) handleMove(ev);
    });
  });
  map.on("mouseout", () => {
    if (moveFrame.current) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = 0;
    moveEvent.current = null;
    hoverPath.current = null;
    hoverPopup.current?.remove();
    releaseHover();
  });
}
