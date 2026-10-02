import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../types";
import { ACTIVITIES, activityOf, placeLabel } from "../types";
import type { FileMeta } from "../api";
import { filtersActive, resetFilters, type Filters, type GroupBy, type SortKey } from "../prefs";
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNumber, tzOf, type TzMode } from "../format";
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
}

/** Sanal liste ölçüleri (px); styles.css'teki .file-row / .group-head yükseklikleriyle aynı. */
const ROW_H = 48;
const ROW_SUB_H = 64;
const HEAD_H = 30;
/** Görünür alanın üstünde ve altında fazladan çizilen yükseklik. */
const OVERSCAN_PX = 400;

type Item =
  | { kind: "head"; key: string; top: number; h: number; group: Group }
  | { kind: "row"; key: string; top: number; h: number; entry: FileEntry; groupKey: string | null };

const Row = memo(function Row({
  entry,
  selected,
  inMulti,
  tags,
  top,
  height,
  onRowClick,
  onZoom,
  onToggle,
  onRemove,
}: {
  entry: FileEntry;
  selected: boolean;
  inMulti: boolean;
  tags: string[] | undefined;
  /** Yalnızca memo karşılaştırması için: saat dilimi kipi değişince tarih yeniden yazılsın. */
  tzMode: TzMode;
  top: number;
  height: number;
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
      style={{ top, height }}
      onClick={(e) => onRowClick(s.path, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })}
      onDoubleClick={() => onZoom(s.path)}
      title={`${s.fileName}\nÇift tıklayınca haritada yakınlaştırılır. Ctrl/⌘ ile tıklayarak birden çok, Shift ile aralık seçebilirsiniz.`}
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


const hasSub = (f: FileEntry, tags: string[] | undefined) => !!placeLabel(f.summary) || !!tags?.length;

/**
 * Sanal liste: yalnızca görünen satırlar (ve biraz fazlası) çizilir. Satır
 * yükseklikleri sabittir (alt satırı olan/olmayan), böylece konumlar ölçmeden
 * hesaplanır. Grup başlığı, ait olduğu grubun satırları kaydırılırken üstte kalır.
 */
function FileList(p: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  /** Kaydırma konumu kare başına bir kez okunur (her kaydırma olayında çizilmesin). */
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (scroller.current) setScrollTop(scroller.current.scrollTop);
    });
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const { items, total, heads } = useMemo(() => {
    const out: Item[] = [];
    let y = 0;
    const addRows = (list: FileEntry[], groupKey: string | null) => {
      for (const f of list) {
        const h = hasSub(f, p.meta[f.summary.path]?.tags) ? ROW_SUB_H : ROW_H;
        out.push({ kind: "row", key: f.summary.path, top: y, h, entry: f, groupKey });
        y += h;
      }
    };
    if (p.groupBy === "none") addRows(p.shown, null);
    else
      for (const g of p.groups) {
        out.push({ kind: "head", key: `g:${g.key}`, top: y, h: HEAD_H, group: g });
        y += HEAD_H;
        if (!p.collapsed.has(g.key)) addRows(g.items, g.key);
      }
    const heads = out.filter((x): x is Extract<Item, { kind: "head" }> => x.kind === "head");
    return { items: out, total: y, heads };
  }, [p.shown, p.groups, p.groupBy, p.collapsed, p.meta]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // Liste kısalınca boşlukta kalınmasın.
  useEffect(() => {
    const el = scroller.current;
    if (el && el.scrollTop !== scrollTop) setScrollTop(el.scrollTop);
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  // Seçili satırı (klavye, harita tıklaması) görünür alana getir.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !p.selected) return;
    const it = items.find((x) => x.kind === "row" && x.key === p.selected);
    if (!it) return;
    const pad = p.groupBy === "none" ? 0 : HEAD_H; // üstte duran grup başlığı
    if (it.top - pad < el.scrollTop) el.scrollTop = Math.max(0, it.top - pad);
    else if (it.top + it.h > el.scrollTop + el.clientHeight) el.scrollTop = it.top + it.h - el.clientHeight;
  }, [p.selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // Görünen aralık: konumlar artan sırada, ikili arama ile.
  const lo = scrollTop - OVERSCAN_PX;
  const hi = scrollTop + viewH + OVERSCAN_PX;
  let a = 0;
  let b = items.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (items[m].top + items[m].h < lo) a = m + 1;
    else b = m;
  }
  const visible: Item[] = [];
  for (let i = a; i < items.length && items[i].top <= hi; i++) visible.push(items[i]);

  // Üstte kalan grup başlığı: kaydırma konumunun içinde bulunduğu grup.
  let sticky: Group | null = null;
  if (scrollTop > 0) {
    let x = 0;
    let y = heads.length;
    while (x < y) {
      const m = (x + y) >> 1;
      if (heads[m].top <= scrollTop) x = m + 1;
      else y = m;
    }
    if (x > 0) sticky = heads[x - 1].group;
  }

  const head = (g: Group, cls = "") => {
    const closed = p.collapsed.has(g.key);
    return (
      <button className={`group-head${cls}`} onClick={() => p.onToggleGroup(g.key)} aria-expanded={!closed}>
        <span className="chev">{closed ? "▸" : "▾"}</span>
        <span className="group-label">{g.label}</span>
        <span className="group-meta">
          {fmtNumber(g.items.length)} · {fmtDistance(g.distanceM)}
          {g.movingMs > 0 && ` · ${fmtDuration(g.movingMs)}`}
        </span>
      </button>
    );
  };

  const anyFilter = filtersActive(p.filters);

  return (
    <div className="file-list" ref={scroller} onScroll={onScroll}>
      {p.groupBy !== "none" && (
        // Yer kaplamaz (negatif kenar boşluğu); her zaman DOM'da durur ki kaydırma konumu oynamasın.
        <div className="sticky-head" style={{ height: HEAD_H, marginBottom: -HEAD_H, visibility: sticky ? undefined : "hidden" }}>
          {sticky && head(sticky)}
        </div>
      )}
      <ul className="vlist" style={{ height: total }}>
        {visible.map((it) =>
          it.kind === "head" ? (
            <li key={it.key} className="group" style={{ top: it.top, height: it.h }}>
              {head(it.group)}
            </li>
          ) : (
            <Row
              key={it.key}
              entry={it.entry}
              selected={it.entry.summary.path === p.selected}
              inMulti={p.multi.has(it.entry.summary.path)}
              tags={p.meta[it.entry.summary.path]?.tags}
              tzMode={p.tzMode}
              top={it.top}
              height={it.h}
              onRowClick={p.onRowClick}
              onZoom={p.onZoom}
              onToggle={p.onToggle}
              onRemove={p.onRemove}
            />
          ),
        )}
      </ul>
      {p.files.length === 0 && !p.loading && (
        <div className="empty-hint">
          GPX, FIT, TCX, KML dosyalarını ya da klasörleri pencereye sürükleyip bırakın veya yukarıdaki düğmeleri kullanın.
        </div>
      )}
      {p.files.length > 0 && p.shown.length === 0 && (
        <div className="empty-hint">
          Filtreye uyan kayıt yok.
          {anyFilter && (
            <div>
              <button className="btn small" onClick={() => p.onFilters(resetFilters(p.filters))}>
                Filtreleri sıfırla
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const anyFilter = filtersActive(p.filters);
  const hiddenCount = p.shown.length - totals.visible;
  const multi = [...p.multi];
  const showMultiHint = !p.multiHintSeen && !!p.selected && multi.length <= 1 && p.shown.length > 1;

  return (
    <aside className="sidebar">
      <div className="sidebar-actions">
        <button className="btn primary" onClick={p.onOpenFiles} title="GPX, FIT, TCX, KML dosyalarını aç (Ctrl/⌘+O)">
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
        </div>
      )}
    </aside>
  );
});
