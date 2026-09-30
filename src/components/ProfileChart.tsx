import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Detail } from "../api";
import { fmtTime } from "../format";

interface Props {
  detail: Detail;
  color: string;
  showSpeed: boolean;
  onHover(index: number | null): void;
}

const nf1 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function ProfileChart({ detail, color, showSpeed, onHover }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

  useEffect(() => {
    const el = host.current!;
    const xs = detail.dist.map((d) => d / 1000);
    const hasEle = detail.ele.some((e) => e != null);
    const hasSpeed = showSpeed && detail.speed.some((s) => s != null);
    const axisColor = cssVar("--text-muted");
    const gridColor = cssVar("--grid");

    const series: uPlot.Series[] = [
      { label: "Mesafe", value: (_u, v) => (v == null ? "—" : `${nf1.format(v)} km`) },
    ];
    const data: uPlot.AlignedData = [xs];
    if (hasEle) {
      series.push({
        label: "Yükseklik",
        scale: "m",
        stroke: color,
        width: 2,
        fill: color + "33",
        spanGaps: false,
        points: { show: false },
        value: (_u, v) => (v == null ? "—" : `${nf0.format(v)} m`),
      });
      data.push(detail.ele as (number | null)[]);
    }
    if (hasSpeed) {
      series.push({
        label: "Hız",
        scale: "kmh",
        stroke: "#6b7280",
        width: 1,
        points: { show: false },
        value: (_u, v) => (v == null ? "—" : `${nf1.format(v)} km/sa`),
      });
      data.push(detail.speed as (number | null)[]);
    }

    const axes: uPlot.Axis[] = [
      {
        stroke: axisColor,
        grid: { stroke: gridColor },
        ticks: { stroke: gridColor },
        values: (_u, splits) => splits.map((v) => `${nf1.format(v)} km`),
      },
    ];
    if (hasEle) {
      axes.push({
        scale: "m",
        stroke: axisColor,
        grid: { stroke: gridColor },
        ticks: { stroke: gridColor },
        size: 56,
        values: (_u, splits) => splits.map((v) => `${nf0.format(v)} m`),
      });
    }
    if (hasSpeed) {
      axes.push({
        scale: "kmh",
        side: 1,
        stroke: axisColor,
        grid: { show: false },
        size: 64,
        values: (_u, splits) => splits.map((v) => `${nf0.format(v)} km/sa`),
      });
    }

    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: el.clientHeight,
      series,
      axes,
      scales: { x: { time: false } },
      legend: { show: true, live: true },
      cursor: { drag: { x: true, y: false }, points: { size: 8 } },
      hooks: {
        setCursor: [
          (u) => {
            const i = u.cursor.idx;
            onHoverRef.current(i == null ? null : i);
            // Lejanda zaman bilgisini de gösteriyoruz.
            const t = i == null ? null : detail.time[i];
            const tEl = el.querySelector(".chart-time");
            if (tEl) tEl.textContent = t == null ? "" : fmtTime(t);
          },
        ],
      },
    };

    if (!hasEle && !hasSpeed) {
      el.innerHTML = '<div class="chart-empty">Bu dosyada yükseklik ya da zaman bilgisi yok.</div>';
      return () => {
        el.innerHTML = "";
      };
    }

    const u = new uPlot(opts, data, el);
    const timeEl = document.createElement("span");
    timeEl.className = "chart-time";
    u.root.querySelector(".u-legend")?.appendChild(timeEl);

    const ro = new ResizeObserver(() => {
      u.setSize({ width: el.clientWidth, height: Math.max(80, el.clientHeight - (u.root.querySelector(".u-legend")?.clientHeight ?? 0)) });
    });
    ro.observe(el);
    const leave = () => onHoverRef.current(null);
    u.over.addEventListener("mouseleave", leave);
    return () => {
      ro.disconnect();
      u.destroy();
    };
  }, [detail, color, showSpeed]);

  return <div ref={host} className="chart" />;
}
