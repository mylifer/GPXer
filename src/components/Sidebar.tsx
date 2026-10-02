import { memo } from "react";
import type { FileEntry } from "../types";
import { ACTIVITIES, activityOf, placeLabel } from "../types";
import type { FileMeta } from "../api";
import type { Filters, GroupBy, SortKey } from "../prefs";
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNumber, tzOf } from "../format";
import { DateRange } from "./DateRange";

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

interface Props {
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
  onRowClick(path: string, mods: RowModifiers): void;
  onZoom(path: string): void;
  onToggle(path: string): void;
  onToggleAll(visible: boolean): void;
  onRemove(paths: string[]): void;
  onOpenFiles(): void;
  onOpenFolder(): void;
  onCloseAll(): void;
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
}

const Row = memo(function Row({
  entry,
  selected,
  inMulti,
  tags,
  onRowClick,
  onZoom,
  onToggle,
  onRemove,
}: {
  entry: FileEntry;
  selected: boolean;
  inMulti: boolean;
  tags: string[] | undefined;
  onRowClick(path: string, mods: RowModifiers): void;
  onZoom(path: string): void;
  onToggle(path: string): void;
  onRemove(paths: string[]): void;
}) {
  const s = entry.summary;
  const place = placeLabel(s);
  return (
    <li
      className={`file-row${selected ? " selected" : ""}${inMulti ? " multi" : ""}${entry.visible ? "" : " hidden-track"}`}
      data-path={s.path}
      onClick={(e) => onRowClick(s.path, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
      onDoubleClick={() => onZoom(s.path)}
      title={`${s.fileName}\nCtrl/⌘ ile tıklayarak birden fazla seçebilirsiniz.`}
    >
      <input
        type="checkbox"
        checked={entry.visible}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(s.path)}
        aria-label="Haritada göster"
        style={{ accentColor: entry.color }}
      />
      <span className="swatch" style={{ background: entry.color }} />
      <div className="file-info">
        <div className="file-name">
          <span className="act" title={activityOf(s.activity).label}>
            {activityOf(s.activity).icon}
          </span>
          {s.name || s.fileName}
        </div>
        <div className="file-meta">
          <span>{s.stats.startTime != null ? fmtDate(s.stats.startTime, tzOf(s)) : "Tarihsiz"}</span>
          <span>{fmtDistance(s.stats.distanceM)}</span>
          {s.stats.movingMs != null && <span>{fmtDuration(s.stats.movingMs)}</span>}
        </div>
        {(!!place || !!tags?.length) && (
          <div className="file-meta sub">
            {place && <span className="place">{place}</span>}
            {tags?.map((t) => (
              <span key={t} className="tag mini">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      <button
        className="icon-btn remove"
        title="Kütüphaneden kaldır"
        onClick={(e) => {
          e.stopPropagation();
          onRemove([s.path]);
        }}
      >
        ×
      </button>
    </li>
  );
});

export const Sidebar = memo(function Sidebar(p: Props) {
  const totals = (() => {
    let dist = 0,
      moving = 0,
      gain = 0,
      visible = 0;
    for (const f of p.shown) {
      if (!f.visible) continue;
      visible++;
      dist += f.summary.stats.distanceM;
      moving += f.summary.stats.movingMs ?? 0;
      gain += f.summary.stats.elevationGainM ?? 0;
    }
    return { dist, moving, gain, visible };
  })();

  const allVisible = p.shown.length > 0 && p.shown.every((f) => f.visible);
  const set = (patch: Partial<Filters>) => p.onFilters({ ...p.filters, ...patch });
  const filtered = p.shown.length !== p.files.length;
  const multi = [...p.multi];

  const renderRows = (items: FileEntry[]) =>
    items.map((f) => (
      <Row
        key={f.summary.path}
        entry={f}
        selected={f.summary.path === p.selected}
        inMulti={p.multi.has(f.summary.path)}
        tags={p.meta[f.summary.path]?.tags}
        onRowClick={p.onRowClick}
        onZoom={p.onZoom}
        onToggle={p.onToggle}
        onRemove={p.onRemove}
      />
    ));

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="btn primary" onClick={p.onOpenFiles}>
          Dosya Aç
        </button>
        <button className="btn" onClick={p.onOpenFolder}>
          Klasör Aç
        </button>
        <span className="spacer" />
        <button className="icon-btn" onClick={p.onSummary} title="Özet (Ctrl/⌘+I)" disabled={p.files.length === 0}>
          ▥
        </button>
        <button className="icon-btn" onClick={p.onSettings} title="Ayarlar (Ctrl/⌘+,)">
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
            value={p.filters.query}
            onChange={(e) => set({ query: e.target.value })}
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
            <select value={p.filters.activity} onChange={(e) => set({ activity: e.target.value })} title="Etkinlik türü">
              <option value="">Tüm türler</option>
              {ACTIVITIES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.label}
                </option>
              ))}
            </select>
            <select value={p.filters.tag} onChange={(e) => set({ tag: e.target.value })} title="Etiket" disabled={!p.allTags.length}>
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
              ⬚ Alan
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
          {p.areaMode && <div className="hint">Haritada sürükleyerek bir alan çizin.</div>}
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
              <option value="none">Gruplama yok</option>
            </select>
          </div>
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

      <ul className="file-list">
        {p.groupBy === "none"
          ? renderRows(p.shown)
          : p.groups.map((g) => {
              const closed = p.collapsed.has(g.key);
              return (
                <li key={g.key} className="group">
                  <button className="group-head" onClick={() => p.onToggleGroup(g.key)} aria-expanded={!closed}>
                    <span className="chev">{closed ? "▸" : "▾"}</span>
                    <span className="group-label">{g.label}</span>
                    <span className="group-meta">
                      {fmtNumber(g.items.length)} · {fmtDistance(g.distanceM)}
                      {g.movingMs > 0 && ` · ${fmtDuration(g.movingMs)}`}
                    </span>
                  </button>
                  {!closed && <ul>{renderRows(g.items)}</ul>}
                </li>
              );
            })}
        {p.files.length === 0 && !p.loading && (
          <li className="empty-hint">
            GPX dosyalarını ya da klasörleri pencereye sürükleyip bırakın veya yukarıdaki düğmeleri kullanın.
          </li>
        )}
        {p.files.length > 0 && p.shown.length === 0 && <li className="empty-hint">Filtreye uyan kayıt yok.</li>}
      </ul>

      {p.files.length > 0 && (
        <div className="totals">
          <div className="totals-head">
            <span>
              <strong>{fmtNumber(totals.visible)}</strong> kayıt
              {filtered && <span className="muted"> ({fmtNumber(p.files.length)} içinden)</span>}
            </span>
            <button className="btn small ghost-inline" onClick={p.onCloseAll} title="Kütüphaneyi temizle">
              Temizle
            </button>
          </div>
          <div className="totals-grid">
            <span>Toplam mesafe</span>
            <strong>{fmtDistance(totals.dist)}</strong>
            <span>Hareket süresi</span>
            <strong>{fmtDuration(totals.moving)}</strong>
            <span>Toplam tırmanış</span>
            <strong>{fmtElevation(totals.gain)}</strong>
          </div>
        </div>
      )}
    </aside>
  );
});
