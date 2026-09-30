import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Detail } from "../api";
import type { Metric, XAxis } from "../prefs";
import { METRICS } from "../types";

interface Props {
  detail: Detail;
  color: string;
  /** Gösterilecek ölçüler; her biri kendi şeridinde çizilir. */
  metrics: Metric[];
  xAxis: XAxis;
  tz?: string;
  /** Dışarıdan (haritadan, oynatmadan) gelen imleç konumu. */
  hoverIdx: number | null;
  range: [number, number] | null;
  onHover(index: number | null): void;
  onRange(range: [number, number] | null): void;
}

const nf1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function metricValues(d: Detail, m: Metric): (number | null)[] {
  return d[m] as (number | null)[];
}

export function hasMetric(d: Detail, m: Metric): boolean {
  const v = metricValues(d, m);
  return v.length > 0 && v.some((x) => x != null);
}

/** Zaman ekseni yalnızca her noktada zaman varsa ve zaman ilerliyorsa kullanılabilir. */
export function canUseTime(d: Detail): boolean {
  let prev = -Infinity;
  for (const t of d.time) {
    if (t == null || t < prev) return false;
    prev = t;
  }
  return d.time.length > 1;
}

export function ProfileChart({ detail, color, metrics, xAxis, tz, hoverIdx, range, onHover, onRange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const plots = useRef<uPlot[]>([]);
  const xs = useRef<number[]>([]);
  const syncing = useRef(false);
  const lastFromChart = useRef<number | null>(null);
  const cb = useRef({ onHover, onRange });
  cb.current = { onHover, onRange };
  const syncKey = useRef(`gpxer-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const el = host.current!;
    const useTime = xAxis === "time" && canUseTime(detail);
    const x = useTime ? detail.time.map((t) => (t as number) / 1000) : detail.dist.map((d) => d / 1000);
    xs.current = x;
    const shown = metrics.filter((m) => hasMetric(detail, m));
    if (shown.length === 0) {
      el.innerHTML = '<div class="chart-empty">Bu dosyada grafik çizilecek yükseklik ya da zaman bilgisi yok.</div>';
      return () => {
        el.innerHTML = "";
      };
    }

    const axisColor = cssVar("--text-muted");
    const gridColor = cssVar("--grid");
    const rows: HTMLDivElement[] = [];
    const created: uPlot[] = [];
    const rowHeight = () => Math.max(60, Math.floor(el.clientHeight / shown.length));

    shown.forEach((m, i) => {
      const meta = METRICS[m];
      const last = i === shown.length - 1;
      const row = document.createElement("div");
      row.className = "chart-row";
      el.appendChild(row);
      rows.push(row);
      const values = metricValues(detail, m);
      // Yükseklik dosyanın rengiyle, diğer ölçüler nötr mürekkeple çizilir.
      const stroke = m === "ele" ? color : cssVar("--text");
      const opts: uPlot.Options = {
        width: el.clientWidth,
        height: rowHeight(),
        legend: { show: false },
        tzDate: tz ? (ts) => uPlot.tzDate(new Date(ts * 1e3), tz) : undefined,
        scales: { x: { time: useTime } },
        series: [
          {},
          {
            label: meta.label,
            stroke,
            width: m === "ele" ? 2 : 1.5,
            fill: m === "ele" ? color + "2e" : undefined,
            spanGaps: false,
            points: { show: false },
          },
        ],
        axes: [
          {
            stroke: axisColor,
            grid: { stroke: gridColor, width: 1 },
            ticks: { show: false },
            size: last ? 28 : 6,
            values: last
              ? useTime
                ? undefined
                : (_u, splits) => splits.map((v) => `${nf1.format(v)} km`)
              : () => [],
          },
          {
            stroke: axisColor,
            grid: { stroke: gridColor, width: 1 },
            ticks: { show: false },
            size: 56,
            values: (_u, splits) => splits.map((v) => (meta.digits ? nf1 : nf0).format(v)),
          },
        ],
        cursor: {
          sync: { key: syncKey.current },
          drag: { x: true, y: false, setScale: false },
          points: { size: 7, fill: stroke },
        },
        hooks: {
          setCursor: [
            (u) => {
              if (syncing.current) return;
              const idx = u.cursor.idx ?? null;
              lastFromChart.current = idx;
              cb.current.onHover(idx);
            },
          ],
          setSelect: [
            (u) => {
              const s = u.select;
              if (s.width < 3) return;
              const a = u.posToIdx(s.left);
              const b = u.posToIdx(s.left + s.width);
              if (b > a) cb.current.onRange([a, b]);
            },
          ],
        },
      };
      const u = new uPlot(opts, [x, values], row);
      // Şerit adı eksen başlığı yerine sol üstte durur; kısa şeritlerde çakışmaz.
      const tag = document.createElement("div");
      tag.className = "chart-row-label";
      tag.textContent = `${meta.label} (${meta.unit})`;
      row.appendChild(tag);
      u.over.addEventListener("mouseleave", () => {
        lastFromChart.current = null;
        cb.current.onHover(null);
      });
      u.over.addEventListener("dblclick", () => cb.current.onRange(null));
      created.push(u);
    });
    plots.current = created;

    const ro = new ResizeObserver(() => {
      for (const u of created) u.setSize({ width: el.clientWidth, height: rowHeight() });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      created.forEach((u) => u.destroy());
      rows.forEach((r) => r.remove());
      plots.current = [];
    };
  }, [detail, color, metrics, xAxis, tz]);

  // Dışarıdan gelen imleç konumunu grafiğe yansıt.
  useEffect(() => {
    const u = plots.current[0];
    if (!u || hoverIdx === lastFromChart.current) return;
    syncing.current = true;
    try {
      if (hoverIdx == null || hoverIdx >= xs.current.length) {
        for (const p of plots.current) p.setCursor({ left: -10, top: -10 });
      } else {
        const left = u.valToPos(xs.current[hoverIdx], "x");
        for (const p of plots.current) p.setCursor({ left, top: p.over.clientHeight / 2 });
      }
    } finally {
      syncing.current = false;
    }
  }, [hoverIdx]);

  // Seçili aralığı tüm şeritlerde göster.
  useEffect(() => {
    for (const u of plots.current) {
      if (!range) {
        u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
        continue;
      }
      const left = u.valToPos(xs.current[range[0]], "x");
      const right = u.valToPos(xs.current[range[1]], "x");
      u.setSelect({ left, width: right - left, top: 0, height: u.over.clientHeight }, false);
    }
  }, [range, detail, metrics, xAxis]);

  return <div ref={host} className="chart" />;
}
