import { memo, useMemo } from "react";
import type { FileEntry } from "../types";
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNumber } from "../format";

export type SortKey = "date-desc" | "date-asc" | "name" | "distance";

export interface Filters {
  query: string;
  from: string; // yyyy-mm-dd ya da ""
  to: string;
  sort: SortKey;
}

interface Props {
  files: FileEntry[];
  /** Filtreden geçen dosyalar, sıralı. */
  shown: FileEntry[];
  filters: Filters;
  selected: string | null;
  loading: { done: number; total: number } | null;
  onFilters(f: Filters): void;
  onSelect(path: string): void;
  onZoom(path: string): void;
  onToggle(path: string): void;
  onToggleAll(visible: boolean): void;
  onRemove(path: string): void;
  onOpenFiles(): void;
  onOpenFolder(): void;
  onCloseAll(): void;
}

const Row = memo(function Row({
  entry,
  selected,
  onSelect,
  onZoom,
  onToggle,
  onRemove,
}: {
  entry: FileEntry;
  selected: boolean;
  onSelect(path: string): void;
  onZoom(path: string): void;
  onToggle(path: string): void;
  onRemove(path: string): void;
}) {
  const s = entry.summary;
  return (
    <li
      className={`file-row${selected ? " selected" : ""}${entry.visible ? "" : " hidden-track"}`}
      data-path={s.path}
      onClick={() => onSelect(s.path)}
      onDoubleClick={() => onZoom(s.path)}
      title={s.path}
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
        <div className="file-name">{s.name || s.fileName}</div>
        <div className="file-meta">
          <span>{fmtDate(s.stats.startTime)}</span>
          <span>{fmtDistance(s.stats.distanceM)}</span>
          {s.stats.movingMs != null && <span>{fmtDuration(s.stats.movingMs)}</span>}
        </div>
      </div>
      <button
        className="icon-btn remove"
        title="Kütüphaneden kaldır"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(s.path);
        }}
      >
        ×
      </button>
    </li>
  );
});

export function Sidebar(p: Props) {
  const totals = useMemo(() => {
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
  }, [p.shown]);

  const allVisible = p.shown.length > 0 && p.shown.every((f) => f.visible);
  const set = (patch: Partial<Filters>) => p.onFilters({ ...p.filters, ...patch });
  const filtered = p.shown.length !== p.files.length;

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="btn primary" onClick={p.onOpenFiles}>
          Dosya Aç
        </button>
        <button className="btn" onClick={p.onOpenFolder}>
          Klasör Aç
        </button>
        {p.files.length > 0 && (
          <button className="btn ghost" onClick={p.onCloseAll} title="Kütüphaneyi temizle">
            Temizle
          </button>
        )}
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
            placeholder="Ad ya da dosya adında ara…"
            value={p.filters.query}
            onChange={(e) => set({ query: e.target.value })}
          />
          <div className="filter-row">
            <label>
              Başlangıç
              <input type="date" value={p.filters.from} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label>
              Bitiş
              <input type="date" value={p.filters.to} onChange={(e) => set({ to: e.target.value })} />
            </label>
          </div>
          <div className="filter-row">
            <label className="check">
              <input type="checkbox" checked={allVisible} onChange={() => p.onToggleAll(!allVisible)} />
              Tümü
            </label>
            <select value={p.filters.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
              <option value="date-desc">Tarih (yeni → eski)</option>
              <option value="date-asc">Tarih (eski → yeni)</option>
              <option value="name">Ad</option>
              <option value="distance">Mesafe</option>
            </select>
          </div>
        </div>
      )}

      <ul className="file-list">
        {p.shown.map((f) => (
          <Row
            key={f.summary.path}
            entry={f}
            selected={f.summary.path === p.selected}
            onSelect={p.onSelect}
            onZoom={p.onZoom}
            onToggle={p.onToggle}
            onRemove={p.onRemove}
          />
        ))}
        {p.files.length === 0 && !p.loading && (
          <li className="empty-hint">
            GPX dosyalarını ya da klasörleri pencereye sürükleyip bırakın veya yukarıdaki düğmeleri kullanın.
          </li>
        )}
        {p.files.length > 0 && p.shown.length === 0 && <li className="empty-hint">Filtreye uyan dosya yok.</li>}
      </ul>

      {p.files.length > 0 && (
        <div className="totals">
          <div>
            <strong>{fmtNumber(totals.visible)}</strong> dosya
            {filtered && <span className="muted"> ({fmtNumber(p.files.length)} içinden)</span>}
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
}
