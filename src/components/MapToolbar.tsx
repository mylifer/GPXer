import { useLayoutEffect, useRef } from "react";
import type { Settings } from "../api";
import type { Prefs } from "../prefs";
import type { FileEntry } from "../types";
import { fmtNumber } from "../format";
import { BASE_LAYERS, type BaseLayer } from "../map/style";
import { PhotoControl } from "./PhotoControl";

/** Haritanın üstündeki araç çubuğu: altlık, katmanlar, renk kipi, dışa aktarma, fotoğraflar. */
export function MapToolbar({
  prefs,
  up,
  baseLayer,
  setBaseLayer,
  files,
  libraryFlights,
  settings,
  applySettings,
  fitAll,
  exportPng,
  placedPhotos,
  pickPhotos,
  clearPhotos,
}: {
  prefs: Prefs;
  up(patch: Partial<Prefs>): void;
  baseLayer: BaseLayer;
  setBaseLayer(b: BaseLayer): void;
  files: FileEntry[];
  libraryFlights: number;
  settings: Settings | null;
  applySettings(s: Settings): void;
  fitAll(): void;
  exportPng(): void;
  placedPhotos: { placed: unknown[]; unplaced: number };
  pickPhotos(folder: boolean): void;
  clearPhotos(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Dar pencerede çubuk birkaç satıra iner; bildirimler (`.toasts`) altında
  // dursun diye alt kenarı haritaya CSS değişkeni olarak verilir.
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const set = () => host.style.setProperty("--toolbar-bottom", `${el.offsetTop + el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="map-toolbar" ref={ref}>
      <button
        className="icon-btn"
        onClick={() => up({ sidebarOpen: !prefs.sidebarOpen })}
        title={prefs.sidebarOpen ? "Kenar çubuğunu gizle (Ctrl/⌘+B)" : "Kenar çubuğunu göster (Ctrl/⌘+B)"}
      >
        {prefs.sidebarOpen ? "⟨" : "☰"}
      </button>
      <div className="segmented">
        {BASE_LAYERS.map((l) => (
          <button key={l.id} className={l.id === baseLayer ? "active" : ""} onClick={() => setBaseLayer(l.id)}>
            {l.label}
          </button>
        ))}
      </div>
      {files.length > 0 && (
        <>
          <div className="segmented">
            <button className={!prefs.heatmap ? "active" : ""} onClick={() => up({ heatmap: false })}>
              İzler
            </button>
            <button
              className={prefs.heatmap ? "active" : ""}
              onClick={() => up({ heatmap: true })}
              title="En çok geçilen yerler (Ctrl/⌘+Shift+H)"
            >
              Isı haritası
            </button>
          </div>
          <label className="map-select" title="İz renkleri">
            <select
              value={prefs.colorMode}
              onChange={(e) => up({ colorMode: e.target.value as Prefs["colorMode"] })}
              disabled={prefs.heatmap}
            >
              <option value="file">Renk: dosyaya göre</option>
              <option value="date">Renk: tarihe göre</option>
            </select>
          </label>
          <button
            className={`btn small${prefs.stopsLayer ? " primary" : ""}`}
            onClick={() => up({ stopsLayer: !prefs.stopsLayer })}
            title="Tüm kayıtlarda en sık duraklama yapılan yerler"
          >
            Duraklamalar
          </button>
          <button
            className={`btn small${prefs.flightsLayer ? " primary" : ""}`}
            onClick={() => up({ flightsLayer: !prefs.flightsLayer })}
            title={
              libraryFlights
                ? `Gösterilen kayıtlardaki uçuşları (300 km/sa üstü boşluklar) yay olarak çiz · kütüphanede ${fmtNumber(libraryFlights)} uçuş`
                : "Kayıtlarda uçuş bulunamadı (300 km/sa üstü, 100 km'den uzun boşluk)"
            }
          >
            ✈ Uçuşlar
          </button>
          <label
            className="check map-check"
            title="Seçili kayıtta nokta kaydedilmemiş aralıkları (uçuş, sinyal kaybı) kesik çizgiyle göster"
          >
            <input type="checkbox" checked={prefs.showGaps} onChange={(e) => up({ showGaps: e.target.checked })} />
            Boşluklar
          </label>
          {settings && (
            <label
              className="check map-check"
              title={
                settings.stats.cleanSpikes
                  ? `Uzağa fırlayıp geri dönen GPS noktaları${
                      settings.stats.collapseStays ? " ve uzun duraklamalardaki konum titremesi" : ""
                    } haritadan ve hesaplardan çıkarılıyor (${fmtNumber(
                      files.reduce((n, f) => n + f.summary.removedPoints, 0),
                    )} GPS sıçraması${
                      settings.stats.collapseStays
                        ? `, duraklamalarda tek noktaya indirilen ${fmtNumber(
                            files.reduce((n, f) => n + (f.summary.collapsedPoints ?? 0), 0),
                          )} nokta`
                        : ""
                    }). Orijinal dosyalar değişmez. Ayrıntılar: Ayarlar.`
                  : "GPS gürültüsü temizlenmiyor; kayıtlar olduğu gibi gösteriliyor."
              }
            >
              <input
                type="checkbox"
                checked={settings.stats.cleanSpikes}
                onChange={(e) =>
                  applySettings({ ...settings, stats: { ...settings.stats, cleanSpikes: e.target.checked } })
                }
              />
              GPS gürültüsünü temizle
            </label>
          )}
          <button
            className="btn small"
            onClick={fitAll}
            title="Listede görünen (filtreye uyan) tüm kayıtlara yakınlaştır (Ctrl/⌘+0)"
          >
            Tümüne yakınlaştır
          </button>
          <button className="btn small" onClick={exportPng} title="Harita görüntüsünü kaydet (Ctrl/⌘+Shift+E)">
            PNG
          </button>
        </>
      )}
      <PhotoControl
        count={placedPhotos.placed.length}
        unplaced={placedPhotos.unplaced}
        on={prefs.photosLayer}
        offset={prefs.photoOffsetH}
        onToggle={() => up({ photosLayer: !prefs.photosLayer })}
        onOffset={(photoOffsetH) => up({ photoOffsetH })}
        onAdd={pickPhotos}
        onClear={clearPhotos}
      />
    </div>
  );
}
