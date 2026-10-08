import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "../types";
import { activityOf, placeLabel } from "../types";
import type { NamedPlace } from "../api";
import { filtersActive, resetFilters } from "../prefs";
import { fmtDate, fmtDistance, fmtDuration, fmtDurationShort, fmtNumber, dayRangeTr, isoToTr, tzOf, type TzMode } from "../format";
import { dayBuckets, rangeShare } from "../days";
import type { Group, RowModifiers, SidebarProps } from "./Sidebar";

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
  from,
  to,
  top,
  height,
  onRowClick,
  onZoom,
  onToggle,
  onRemove,
  overlap,
}: {
  entry: FileEntry;
  /** Çakışan kayıtların açıklaması (yoksa undefined). */
  overlap: string | undefined;
  /** Yalnızca memo karşılaştırması için: yer adları değişince yeniden yazılsın. */
  places: NamedPlace[];
  selected: boolean;
  inMulti: boolean;
  tags: string[] | undefined;
  /** Yalnızca memo karşılaştırması için: saat dilimi kipi değişince tarih yeniden yazılsın. */
  tzMode: TzMode;
  /** Tarih filtresi (aralıktaki payı göstermek için). */
  from: string;
  to: string;
  top: number;
  height: number;
  onRowClick(path: string, mods: RowModifiers): void;
  onZoom(path: string): void;
  onToggle(path: string): void;
  onRemove(paths: string[]): void;
}) {
  const s = entry.summary;
  const place = placeLabel(s);
  const days = dayBuckets(s);
  const share = rangeShare(s, from, to);
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
          {overlap && (
            <span className="overlap-badge" title={overlap}>
              ⧉
            </span>
          )}
          <span data-no-i18n>{s.name || s.fileName}</span>
        </div>
        <div className="file-meta">
          <span
            className="when"
            title={days.length > 1 ? `${isoToTr(days[0].day)} – ${isoToTr(days[days.length - 1].day)} · ${fmtNumber(days.length)} gün` : undefined}
          >
            {days.length > 1
              ? dayRangeTr(days[0].day, days[days.length - 1].day)
              : s.stats.startTime != null
                ? fmtDate(s.stats.startTime, tzOf(s))
                : "Tarihsiz"}
          </span>
          <span>{fmtDistance(s.stats.distanceM)}</span>
          {s.stats.movingMs != null && <span>{fmtDurationShort(s.stats.movingMs)}</span>}
        </div>
        {(!!place || !!tags?.length || share.partial) && (
          <div className="file-meta sub">
            {share.partial && (
              <span className="in-range" title="Kaydın tarih filtresindeki günlere düşen kısmı">
                bu aralıkta {fmtDistance(share.distanceM)}
              </span>
            )}
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

const hasSub = (f: FileEntry, tags: string[] | undefined, from: string, to: string) =>
  !!placeLabel(f.summary) || !!tags?.length || rangeShare(f.summary, from, to).partial;

/**
 * Sanal liste: yalnızca görünen satırlar (ve biraz fazlası) çizilir. Satır
 * yükseklikleri sabittir (alt satırı olan/olmayan), böylece konumlar ölçmeden
 * hesaplanır. Grup başlığı, ait olduğu grubun satırları kaydırılırken üstte kalır.
 */
export function FileList(p: SidebarProps) {
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

  const names = useMemo(() => new Map(p.files.map((f) => [f.summary.path, f.summary.name || f.summary.fileName])), [p.files]);
  const overlapTip = (path: string) => {
    const l = p.overlaps.get(path);
    if (!l?.length) return undefined;
    const lines = l.slice(0, 6).map((o) => `• ${names.get(o.path) ?? o.path} (${fmtDuration(o.ms)})`);
    if (l.length > 6) lines.push(`… ve ${l.length - 6} kayıt daha`);
    return `Zamanı çakışan kayıtlar:\n${lines.join("\n")}`;
  };

  const { items, total, heads } = useMemo(() => {
    const out: Item[] = [];
    let y = 0;
    const addRows = (list: FileEntry[], groupKey: string | null) => {
      for (const f of list) {
        const h = hasSub(f, p.meta[f.summary.path]?.tags, p.filters.from, p.filters.to) ? ROW_SUB_H : ROW_H;
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
  }, [p.shown, p.groups, p.groupBy, p.collapsed, p.meta, p.filters.from, p.filters.to, p.places]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div
        className={`group-head${cls}`}
        role="button"
        tabIndex={0}
        onClick={() => p.onToggleGroup(g.key)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          p.onToggleGroup(g.key);
        }}
        aria-expanded={!closed}
      >
        <span className="chev">{closed ? "▸" : "▾"}</span>
        <span className="group-label">{g.label}</span>
        <span className="group-meta">
          {fmtNumber(g.items.length)} · {fmtDistance(g.distanceM)}
          {g.movingMs > 0 && ` · ${fmtDurationShort(g.movingMs)}`}
        </span>
        {g.key.startsWith("trip:") && (
          <button
            className="group-select"
            title="Gezinin bütün kayıtlarını seç: tek dosyada dışa aktarma, birleştirme ve haritada gösterme için"
            onClick={(e) => {
              e.stopPropagation();
              p.onSelectGroup(g.items.map((f) => f.summary.path));
            }}
          >
            Seç
          </button>
        )}
      </div>
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
              from={p.filters.from}
              to={p.filters.to}
              top={it.top}
              height={it.h}
              onRowClick={p.onRowClick}
              onZoom={p.onZoom}
              onToggle={p.onToggle}
              onRemove={p.onRemove}
              overlap={overlapTip(it.entry.summary.path)}
              places={p.places}
            />
          ),
        )}
      </ul>
      {p.files.length === 0 && !p.loading && (
        <div className="empty-hint">
          GPX, FIT, TCX, KML dosyalarını, Google konum geçmişini (Takeout JSON) ya da klasörleri pencereye sürükleyip bırakın veya yukarıdaki düğmeleri
          kullanın.
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
