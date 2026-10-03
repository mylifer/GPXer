import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import { fmtNumber } from "../format";
import type { PlacedPhoto } from "../photos";
import { requestThumb } from "../thumbs";
import type { MapRefs } from "./context";
import { photoInfoHtml, photoTitle } from "./popups";

const PHOTO_CELL = 56;
const PHOTO_MAX_MARKERS = 300;

// Fotoğraflar: ekranda yakın düşenler tek işarette toplanır (sayıyla); en fazla
// PHOTO_MAX_MARKERS işaret çizilir. Harita her durduğunda yeniden gruplanır.
export function usePhotoMarkers(r: MapRefs, photos: PlacedPhoto[] | null) {
  const { mapRef, live, hoverPopup } = r;
  const photoMarkers = useRef(new Map<string, { marker: maplibregl.Marker; cancel(): void }>());
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const markers = photoMarkers.current;
    const clear = () => {
      for (const m of markers.values()) {
        m.cancel();
        m.marker.remove();
      }
      markers.clear();
    };
    // Fotoğraf listesi değişti (saat düzeltmesi, kayıtlar): konum ve tıklama
    // işleyicisi eskimesin diye işaretler baştan kurulur.
    clear();
    if (!photos?.length) return;
    const render = () => {
      const list = live.current.photos ?? [];
      const c = map.getContainer();
      const w = c.clientWidth;
      const h = c.clientHeight;
      const cells = new Map<string, PlacedPhoto[]>();
      for (const ph of list) {
        const pt = map.project([ph.lon, ph.lat]);
        if (pt.x < -PHOTO_CELL || pt.y < -PHOTO_CELL || pt.x > w + PHOTO_CELL || pt.y > h + PHOTO_CELL) continue;
        const key = `${Math.floor(pt.x / PHOTO_CELL)}:${Math.floor(pt.y / PHOTO_CELL)}`;
        const cell = cells.get(key);
        if (cell) cell.push(ph);
        else cells.set(key, [ph]);
      }
      const keep = new Set<string>();
      let n = 0;
      for (const group of cells.values()) {
        if (n++ >= PHOTO_MAX_MARKERS) break;
        const first = group[0];
        const key = `${first.path}|${group.length}|${first.lon.toFixed(6)},${first.lat.toFixed(6)}`;
        keep.add(key);
        if (markers.has(key)) continue;
        const el = document.createElement("div");
        el.className = "photo-marker";
        // Küçük resim yüklenene dek yer tutucu simge.
        const ph = document.createElement("span");
        ph.className = "photo-placeholder";
        ph.textContent = "📷";
        el.appendChild(ph);
        const cancel = requestThumb(first.path, (url) => {
          if (!url) return;
          const img = document.createElement("img");
          img.src = url;
          img.alt = "";
          ph.replaceWith(img);
        });
        if (group.length > 1) {
          const badge = document.createElement("span");
          badge.className = "photo-count";
          badge.textContent = fmtNumber(group.length);
          el.appendChild(badge);
        }
        const sum = first.record ? live.current.summaryOf(first.record) : undefined;
        el.title = photoTitle(group, sum);
        const stop = (e: Event) => e.stopPropagation();
        el.addEventListener("mousedown", stop);
        el.addEventListener("dblclick", stop);
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          if (group.length > 1) {
            const b = new maplibregl.LngLatBounds([first.lon, first.lat], [first.lon, first.lat]);
            for (const g of group) b.extend([g.lon, g.lat]);
            map.fitBounds(b, { padding: 80, maxZoom: Math.max(map.getZoom() + 2, 18), duration: 500 });
            return;
          }
          openPhoto(map, first, r);
        });
        el.addEventListener("mouseenter", () => {
          hoverPopup.current?.remove();
        });
        markers.set(key, {
          marker: new maplibregl.Marker({ element: el, anchor: "bottom" }).setLngLat([first.lon, first.lat]).addTo(map),
          cancel,
        });
      }
      for (const [k, m] of markers) {
        if (!keep.has(k)) {
          m.cancel();
          m.marker.remove();
          markers.delete(k);
        }
      }
    };
    render();
    map.on("moveend", render);
    return () => {
      map.off("moveend", render);
    };
  }, [photos]);
  useEffect(
    () => () =>
      photoMarkers.current.forEach((m) => {
        m.cancel();
        m.marker.remove();
      }),
    [],
  );
}

/** Fotoğraf kutusu: büyük önizleme, ad, çekim zamanı, eşleşen kayıt. */
function openPhoto(map: maplibregl.Map, ph: PlacedPhoto, r: MapRefs) {
  const { live, hoverPopup, chooser, chooserPaths } = r;
  chooser.current?.remove();
  hoverPopup.current?.remove();
  const sum = ph.record ? live.current.summaryOf(ph.record) : undefined;
  const box = document.createElement("div");
  box.className = "photo-box";
  const slot = document.createElement("div");
  slot.className = "photo-preview-placeholder";
  slot.textContent = "📷";
  box.appendChild(slot);
  const cancelThumb = requestThumb(ph.path, (url) => {
    if (!url) {
      slot.remove();
      return;
    }
    const img = document.createElement("img");
    img.src = url;
    img.alt = ph.name;
    slot.replaceWith(img);
  });
  const info = document.createElement("div");
  info.innerHTML = photoInfoHtml(ph, sum);
  box.appendChild(info);
  if (sum) {
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = "Kaydı seç";
    btn.onclick = () => {
      chooser.current?.remove();
      live.current.onPhotoRecord(sum.path);
    };
    box.appendChild(btn);
  }
  chooserPaths.current = [];
  chooser.current = new maplibregl.Popup({ closeButton: true, maxWidth: "320px", className: "chooser-popup", offset: 40 })
    .setLngLat([ph.lon, ph.lat])
    .setDOMContent(box)
    .addTo(map);
  chooser.current.on("close", cancelThumb);
}
