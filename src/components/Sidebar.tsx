import { memo, useMemo } from "react";
import type { FileEntry } from "../types";
import { ACTIVITIES } from "../types";
import type { FileMeta, NamedPlace } from "../api";
import type { Overlap } from "../overlaps";
import { filtersActive, resetFilters, type Filters, type GroupBy, type SortKey } from "../prefs";
import { fmtDistance, fmtDuration, fmtElevation, fmtNumber, type TzMode } from "../format";
import { dedupedTotals } from "../days";
import { DateRange } from "./DateRange";
import { FileList } from "./FileList";
import { useDebouncedText } from "../hooks/useDebouncedText";

export interface Group {
  key: string;
  label: string;
  items: FileEntry[];
  distanceM: number;
  movingMs: number;
}

export interface RowModifiers {
  toggle: boolean;
  range: boolean;
}

export interface SidebarProps {
  files: FileEntry[];
  /** Filtreden geçen dosyalar, sıralı. */
  shown: FileEntry[];
  groups: Group[];
  groupBy: GroupBy;
  collapsed: Set<string>;
  filters: Filters;
  years: number[];
  selected: string | null;
  multi: Set<string>;
  loading: { done: number; total: number } | null;
  onFilters(f: Filters): void;
  onGroupBy(g: GroupBy): void;
  onToggleGroup(key: string): void;
  /** Grubun bütün kayıtlarını seç (gezi grupları). */
  onSelectGroup(paths: string[]): void;
  onRowClick(path: string, mods: RowModifiers): void;
  onZoom(path: string): void;
  onToggle(path: string): void;
  onToggleAll(visible: boolean): void;
  onRemove(paths: string[]): void;
  onOpenFiles(): void;
  onOpenFolder(): void;
  onSettings(): void;
  onSummary(): void;
  onMerge(): void;
  onExportCsv(): void;
  onSetVisible(paths: string[], visible: boolean): void;
  onClearMulti(): void;
  meta: Record<string, FileMeta>;
  allTags: string[];
  /** Etkin güzergâh filtresinin açıklaması. */
  routeLabel: string | null;
  areaMode: boolean;
  onAreaMode(on: boolean): void;
  onCompare(): void;
  onTagMany(): void;
  onHelp(): void;
  /** Saat dilimi kipi: değişince satırlardaki tarihler yeniden yazılır. */
  tzMode: TzMode;
  multiHintSeen: boolean;
  onDismissMultiHint(): void;
  /** Zamanı çakışan kayıtlar. */
  overlaps: Map<string, Overlap[]>;
  /** Adlandırılmış yerler: değişince satırlardaki yer adları yeniden yazılır. */
  places: NamedPlace[];
  onGoTo(): void;
  onDay(): void;
  /** Kopya kayıt grubu sayısı ve kopya penceresi. */
  duplicateGroups: number;
  onDuplicates(): void;
  onExportFiltered(): void;
  onExportMulti(): void;
  /** Seçili kayıtların (bir gezinin) tek sayfalık hikâyesi. */
  onTripStory(): void;
}

export const Sidebar = memo(function Sidebar(p: SidebarProps) {
  // Aynı yolculuğun kopyaları bir kez sayılır (bkz. dedupedDays).
  const totals = useMemo(() => {
    const vis = p.shown.filter((f) => f.visible).map((f) => f.summary);
    const t = dedupedTotals(vis, p.filters.from, p.filters.to);
    return { dist: t.distanceM, moving: t.movingMs, gain: t.gainM, visible: vis.length };
  }, [p.shown, p.filters.from, p.filters.to, p.tzMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const allVisible = p.shown.length > 0 && p.shown.every((f) => f.visible);
  const set = (patch: Partial<Filters>) => p.onFilters({ ...p.filters, ...patch });
  const [query, setQuery] = useDebouncedText(p.filters.query, (q) => set({ query: q }));
  const filtered = p.shown.length !== p.files.length;
  const anyFilter = filtersActive(p.filters);
  const hiddenCount = p.shown.length - totals.visible;
  const multi = [...p.multi];
  const showMultiHint = !p.multiHintSeen && !!p.selected && multi.length <= 1 && p.shown.length > 1;

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="btn primary" onClick={p.onOpenFiles} title="GPX, FIT, TCX, KML dosyalarını ya da Google konum geçmişini (JSON) aç (Ctrl/⌘+O)">
          Dosya Aç
        </button>
        <button className="btn" onClick={p.onOpenFolder} title="Bir klasördeki tüm kayıtları aç (Ctrl/⌘+Shift+O)">
          Klasör Aç
        </button>
        <span className="spacer" />
        <button
          className="icon-btn labeled"
          onClick={p.onSummary}
          title="Özet: dönemlere ve türlere göre toplamlar, takvim, sık güzergâhlar (Ctrl/⌘+I)"
          aria-label="Özet"
          disabled={p.files.length === 0}
        >
          ▥ <span>Özet</span>
        </button>
        <button className="icon-btn" onClick={p.onHelp} title="Kısayollar ve yardım (?)" aria-label="Kısayollar ve yardım">
          ?
        </button>
        <button className="icon-btn" onClick={p.onSettings} title="Ayarlar (Ctrl/⌘+,)" aria-label="Ayarlar">
          ⚙
        </button>
      </div>

      {p.loading && (
        <div className="progress" aria-live="polite">
          <div className="progress-bar" style={{ width: `${(p.loading.done / Math.max(1, p.loading.total)) * 100}%` }} />
          <span>
            Yükleniyor… {fmtNumber(p.loading.done)} / {fmtNumber(p.loading.total)}
          </span>
        </div>
      )}

      {p.files.length > 0 && (
        <div className="filters">
          <input
            type="search"
            placeholder="Ad, yer, etiket ya da notta ara…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <DateRange
            from={p.filters.from}
            to={p.filters.to}
            years={p.years}
            onChange={(from, to) => set({ from, to })}
          />
          {(p.filters.from || p.filters.to) && (
            <label className="check small">
              <input
                type="checkbox"
                checked={p.filters.includeUndated}
                onChange={(e) => set({ includeUndated: e.target.checked })}
              />
              Tarihsiz kayıtları da göster
            </label>
          )}
          <div className="filter-row">
            <select value={p.filters.activity} onChange={(e) => set({ activity: e.target.value })} title="Etkinlik türüne göre filtrele">
              <option value="">Tüm türler</option>
              {ACTIVITIES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.label}
                </option>
              ))}
            </select>
            <select
              value={p.filters.tag}
              onChange={(e) => set({ tag: e.target.value })}
              title="Etikete göre filtrele"
              disabled={!p.allTags.length}
            >
              <option value="">{p.allTags.length ? "Tüm etiketler" : "Etiket yok"}</option>
              {p.allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              className={`btn small${p.areaMode ? " primary" : ""}`}
              onClick={() => p.onAreaMode(!p.areaMode)}
              title="Haritada sürükleyerek bir alan çizin; yalnızca oradan geçen kayıtlar listelenir"
            >
              ⬚ Alan seç
            </button>
          </div>
          <div className="filter-row">
            <button
              className={`btn small${p.filters.overlap ? " primary" : ""}`}
              onClick={() => set({ overlap: !p.filters.overlap })}
              disabled={!p.overlaps.size && !p.filters.overlap}
              title={
                p.overlaps.size
                  ? "Yalnızca zamanı başka bir kayıtla en az 30 dakika çakışan kayıtları göster (ör. aynı anda iki cihazla kaydedilenler)"
                  : "Zamanı çakışan kayıt yok"
              }
            >
              ⧉ Çakışanlar{p.overlaps.size ? ` (${fmtNumber(p.overlaps.size)})` : ""}
            </button>
            {p.duplicateGroups > 0 && (
              <button
                className="btn small"
                onClick={p.onDuplicates}
                title="Aynı yolculuğun farklı adla ya da biraz farklı kesilmiş kopyaları: hangisi tutulsun?"
              >
                ⧉ Kopyalar ({fmtNumber(p.duplicateGroups)})
              </button>
            )}
            <button
              className="btn small"
              onClick={p.onGoTo}
              title="Ne zaman neredeydim? Bir tarih ve saat girin; o anı kapsayan kayda gidilir (G)"
            >
              🕑 Tarihe git
            </button>
            <button className="btn small" onClick={p.onDay} title="Bir günün akışı: nerede durulmuş, nereden nereye gidilmiş">
              📅 Gün akışı
            </button>
          </div>
          {(p.filters.area || p.filters.route) && (
            <div className="chips">
              {p.filters.area && (
                <span className="chip on">
                  Seçilen alandan geçenler
                  <button className="tag-x" onClick={() => set({ area: null })} aria-label="Alan filtresini kaldır">
                    ×
                  </button>
                </span>
              )}
              {p.filters.route && (
                <span className="chip on">
                  Güzergâh: {p.routeLabel ?? "seçili"}
                  <button className="tag-x" onClick={() => set({ route: null })} aria-label="Güzergâh filtresini kaldır">
                    ×
                  </button>
                </span>
              )}
            </div>
          )}
          {p.areaMode && <div className="hint">Haritada sürükleyerek bir alan çizin (Esc: vazgeç).</div>}
          <div className="filter-row">
            <label className="check">
              <input type="checkbox" checked={allVisible} onChange={() => p.onToggleAll(!allVisible)} />
              Tümü
            </label>
            <select value={p.filters.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} title="Sıralama">
              <option value="date-desc">Yeni → eski</option>
              <option value="date-asc">Eski → yeni</option>
              <option value="name">Ad</option>
              <option value="distance">Mesafe</option>
            </select>
            <select value={p.groupBy} onChange={(e) => p.onGroupBy(e.target.value as GroupBy)} title="Gruplama">
              <option value="month">Aya göre</option>
              <option value="year">Yıla göre</option>
              <option value="trip">Geziye göre</option>
              <option value="none">Gruplama yok</option>
            </select>
          </div>
          {anyFilter && (
            <button className="btn small reset-filters" onClick={() => p.onFilters(resetFilters(p.filters))}>
              Filtreleri sıfırla
            </button>
          )}
        </div>
      )}

      {multi.length > 1 && (
        <div className="multi-bar">
          <strong>{multi.length} kayıt seçili</strong>
          <div className="multi-actions">
            {multi.length === 2 && (
              <button className="btn small primary" onClick={p.onCompare}>
                Karşılaştır
              </button>
            )}
            <button className="btn small" onClick={p.onMerge}>
              Birleştir
            </button>
            <button className="btn small" onClick={p.onTagMany}>
              Etiketle
            </button>
            <button className="btn small" onClick={p.onExportCsv}>
              CSV
            </button>
            <button className="btn small" onClick={p.onExportMulti} title="Seçili kayıtları tek dosyada dışa aktar (GPX, KML, TCX, FIT)">
              Dışa aktar…
            </button>
            <button className="btn small" onClick={p.onTripStory} title="Seçili kayıtları tek sayfalık gezi hikâyesinde birleştir (HTML: harita, günler, geceler, fotoğraflar)">
              Gezi hikâyesi…
            </button>
            <button className="btn small" onClick={() => p.onSetVisible(multi, true)}>
              Göster
            </button>
            <button className="btn small" onClick={() => p.onSetVisible(multi, false)}>
              Gizle
            </button>
            <button className="btn small danger" onClick={() => p.onRemove(multi)}>
              Kaldır
            </button>
            <button className="icon-btn" onClick={p.onClearMulti} title="Seçimi temizle">
              ×
            </button>
          </div>
        </div>
      )}

      {showMultiHint && (
        <div className="hint multi-hint">
          <span>Ctrl/⌘ ile birden çok kayıt seçip karşılaştırabilir ya da birleştirebilirsiniz.</span>
          <button className="icon-btn tiny" onClick={p.onDismissMultiHint} title="Bir daha gösterme" aria-label="İpucunu kapat">
            ×
          </button>
        </div>
      )}

      <FileList {...p} />

      {p.files.length > 0 && (
        <div className="totals">
          <div className="totals-head">
            <span>
              <strong>{fmtNumber(p.shown.length)}</strong> kayıt gösteriliyor
              {filtered && <span className="muted"> (toplam {fmtNumber(p.files.length)})</span>}
              {hiddenCount > 0 && (
                <span className="muted" title="Filtreye uyan ama haritada gizlenen kayıtlar toplamlara katılmaz">
                  {" "}
                  · {fmtNumber(hiddenCount)} gizli
                </span>
              )}
            </span>
          </div>
          <div className="totals-grid">
            <span>Toplam mesafe{hiddenCount > 0 ? " (görünenler)" : ""}</span>
            <strong>{fmtDistance(totals.dist)}</strong>
            <span>Hareket süresi</span>
            <strong>{fmtDuration(totals.moving)}</strong>
            <span>Toplam tırmanış</span>
            <strong>{fmtElevation(totals.gain)}</strong>
          </div>
          <button
            className="btn small totals-export"
            onClick={p.onExportFiltered}
            disabled={p.shown.length === 0}
            title="Listede görünen (filtreye uyan) tüm kayıtları tek dosyada dışa aktar (GPX, KML, TCX, FIT)"
          >
            {filtered ? "Filtrelenenleri dışa aktar…" : "Tümünü dışa aktar…"}
          </button>
        </div>
      )}
    </aside>
  );
});
