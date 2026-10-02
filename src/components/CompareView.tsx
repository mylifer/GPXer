import { useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { Detail } from "../api";
import { METRICS, type FileEntry } from "../types";
import type { Metric } from "../prefs";
import { fmtDate, fmtDistance, fmtDuration, fmtSpeed, fmtUnit, tzOf } from "../format";
import { hasMetric, metricValues } from "./ProfileChart";
import { PLAY_SPEEDS } from "./DetailPanel";

export type Cursor = { lon: number; lat: number; color: string };

interface Props {
  a: FileEntry;
  b: FileEntry;
  detailA: Detail | null;
  detailB: Detail | null;
  height: number;
  playSpeed: number;
  onPlaySpeed(v: number): void;
  onCursors(c: Cursor[]): void;
  onClose(): void;
}

const GRID = 600;

/** d'nin dizideki konumu (artan dizi), kesirli sıra. */
function posOf(arr: number[], v: number): number | null {
  const n = arr.length;
  if (n === 0 || v < arr[0] || v > arr[n - 1]) return null;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid;
  }
  const span = arr[hi] - arr[lo];
  return lo + (span > 0 ? (v - arr[lo]) / span : 0);
}

function at(values: (number | null)[], pos: number | null): number | null {
  if (pos == null) return null;
  const i = Math.floor(pos);
  const a = values[i];
  const b = values[Math.min(values.length - 1, i + 1)];
  if (a == null || b == null) return a ?? b ?? null;
  return a + (b - a) * (pos - i);
}

function elapsed(d: Detail): number[] | null {
  const t0 = d.time[0];
  if (t0 == null || d.time.some((t) => t == null)) return null;
  return d.time.map((t) => (t! - t0) / 1000);
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function CompareView({ a, b, detailA, detailB, height, playSpeed, onPlaySpeed, onCursors, onClose }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [metricPref, setMetric] = useState<Metric>("speed");
  const [hoverD, setHoverD] = useState<number | null>(null);
  const [playT, setPlayT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef(playT);
  playRef.current = playT;
  const cb = useRef(onCursors);
  cb.current = onCursors;

  const ready = detailA && detailB;
  const metrics = (["ele", "speed", "hr", "cad", "power", "temp"] as Metric[]).filter(
    (m) => ready && hasMetric(detailA, m) && hasMetric(detailB, m),
  );
  // Seçilen ölçü iki kayıtta yoksa (ör. zamansız kayıtta hız) ilk uygun ölçüye düş.
  const options: Metric[] = metrics.length ? metrics : ["ele"];
  const metric: Metric = options.includes(metricPref) ? metricPref : options[0];
  const ea = useMemo(() => (detailA ? elapsed(detailA) : null), [detailA]);
  const eb = useMemo(() => (detailB ? elapsed(detailB) : null), [detailB]);

  // Ortak mesafe ızgarası üzerinde iki kaydın ölçüsü ve zaman farkı.
  const data = useMemo(() => {
    if (!detailA || !detailB) return null;
    const max = Math.max(detailA.dist[detailA.dist.length - 1] ?? 0, detailB.dist[detailB.dist.length - 1] ?? 0);
    const xs: number[] = [];
    const va: (number | null)[] = [];
    const vb: (number | null)[] = [];
    const gap: (number | null)[] = [];
    for (let k = 0; k < GRID; k++) {
      const d = (max * k) / (GRID - 1);
      const pa = posOf(detailA.dist, d);
      const pb = posOf(detailB.dist, d);
      xs.push(d / 1000);
      va.push(at(metricValues(detailA, metric), pa));
      vb.push(at(metricValues(detailB, metric), pb));
      const ta = ea ? at(ea, pa) : null;
      const tb = eb ? at(eb, pb) : null;
      // Pozitif: B bu noktaya A'dan önce varmış (B önde).
      gap.push(ta != null && tb != null ? (ta - tb) / 60 : null);
    }
    return { xs, va, vb, gap };
  }, [detailA, detailB, metric, ea, eb]);

  useEffect(() => {
    const el = host.current;
    if (!el || !data) return;
    const axisColor = cssVar("--text-muted");
    const grid = cssVar("--grid");
    const meta = METRICS[metric];
    const key = `cmp-${Math.random().toString(36).slice(2)}`;
    const mk = (series: uPlot.Series[], values: (number | null)[][], label: string, last: boolean, h: number) => {
      const row = document.createElement("div");
      row.className = "chart-row";
      row.style.flex = `${h} 1 0`;
      el.appendChild(row);
      const u = new uPlot(
        {
          width: el.clientWidth,
          height: h,
          legend: { show: false },
          scales: last
            ? {
                x: { time: false },
                // Fark ekseni sıfır etrafında simetrik: üst yarı B önde, alt yarı A önde.
                y: {
                  range: (_u, min, max) => {
                    const m = Math.max(1, Math.abs(min ?? 0), Math.abs(max ?? 0)) * 1.1;
                    return [-m, m];
                  },
                },
              }
            : { x: { time: false } },
          series: [{}, ...series],
          axes: [
            {
              stroke: axisColor,
              grid: { stroke: grid },
              ticks: { show: false },
              size: last ? 28 : 6,
              values: last ? (_u, s) => s.map((v) => `${v.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} km`) : () => [],
            },
            { stroke: axisColor, grid: { stroke: grid }, ticks: { show: false }, size: 56 },
          ],
          cursor: { sync: { key }, drag: { x: false, y: false } },
          hooks: {
            setCursor: [
              (u) => {
                const i = u.cursor.idx;
                setHoverD(i == null ? null : data.xs[i] * 1000);
              },
            ],
          },
        },
        [data.xs, ...values],
        row,
      );
      const tag = document.createElement("div");
      tag.className = "chart-row-label";
      tag.textContent = label;
      row.appendChild(tag);
      u.over.addEventListener("mouseleave", () => setHoverD(null));
      return { u, row };
    };
    const hTop = Math.max(80, Math.floor(el.clientHeight * 0.62));
    const hBot = Math.max(60, el.clientHeight - hTop);
    const top = mk(
      [
        { stroke: a.color, width: 2, points: { show: false } },
        { stroke: b.color, width: 2, points: { show: false } },
      ],
      [data.va, data.vb],
      `${meta.label} (${meta.unit})`,
      false,
      hTop,
    );
    const bottom = mk(
      [{ stroke: cssVar("--text"), width: 1.5, points: { show: false }, fill: "rgba(120,120,120,0.12)" }],
      [data.gap],
      "Zaman farkı (dk) · artı: B önde",
      true,
      hBot,
    );
    const ro = new ResizeObserver(() => {
      const t = Math.max(80, Math.floor(el.clientHeight * 0.62));
      top.u.setSize({ width: el.clientWidth, height: t });
      bottom.u.setSize({ width: el.clientWidth, height: Math.max(60, el.clientHeight - t) });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      for (const p of [top, bottom]) {
        p.u.destroy();
        p.row.remove();
      }
    };
  }, [data, a.color, b.color, metric]);

  // Oynatma: iki kayıt aynı anda başlamış gibi, geçen süreye göre.
  useEffect(() => {
    if (!playing || !ea || !eb) return;
    const end = Math.max(ea[ea.length - 1], eb[eb.length - 1]);
    let raf = 0;
    let last: number | null = null;
    let t = playRef.current ?? 0;
    const step = (now: number) => {
      t += last == null ? 0 : ((now - last) / 1000) * playSpeed;
      last = now;
      setPlayT(Math.min(t, end));
      if (t >= end) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, ea, eb, playSpeed]);

  // Haritadaki iki imleç: oynatılıyorsa geçen süreye, değilse grafikteki mesafeye göre.
  const position = (d: Detail, pos: number | null) =>
    pos == null ? null : { lon: at(d.lon, pos)!, lat: at(d.lat, pos)! };
  const state = useMemo(() => {
    if (!detailA || !detailB) return null;
    if (playT != null && ea && eb) {
      const pa = posOf(ea, Math.min(playT, ea[ea.length - 1]));
      const pb = posOf(eb, Math.min(playT, eb[eb.length - 1]));
      return {
        mode: "time" as const,
        pa,
        pb,
        da: at(detailA.dist, pa),
        db: at(detailB.dist, pb),
      };
    }
    if (hoverD != null) {
      const pa = posOf(detailA.dist, hoverD);
      const pb = posOf(detailB.dist, hoverD);
      return { mode: "dist" as const, pa, pb, ta: ea ? at(ea, pa) : null, tb: eb ? at(eb, pb) : null };
    }
    return null;
  }, [detailA, detailB, playT, hoverD, ea, eb]);

  useEffect(() => {
    const out: Cursor[] = [];
    if (state && detailA && detailB) {
      const pa = position(detailA, state.pa);
      const pb = position(detailB, state.pb);
      if (pa) out.push({ ...pa, color: a.color });
      if (pb) out.push({ ...pb, color: b.color });
    }
    cb.current(out);
  }, [state, detailA, detailB, a.color, b.color]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => cb.current([]), []);

  const name = (f: FileEntry) => `${f.summary.name || f.summary.fileName} · ${fmtDate(f.summary.stats.startTime, tzOf(f.summary))}`;
  let readout: string | null = null;
  if (state?.mode === "dist" && hoverD != null) {
    const { ta, tb } = state;
    readout = `${fmtDistance(hoverD)} noktası: A ${ta != null ? fmtDuration(ta * 1000) : "—"}, B ${tb != null ? fmtDuration(tb * 1000) : "—"}`;
    if (ta != null && tb != null && Math.abs(ta - tb) >= 1) {
      readout += ` · ${ta > tb ? "B" : "A"} ${fmtDuration(Math.abs(ta - tb) * 1000)} önde`;
    }
  } else if (state?.mode === "time" && playT != null) {
    const { da, db } = state;
    readout = `${fmtDuration(playT * 1000)} sonra: A ${fmtDistance(da)}, B ${fmtDistance(db)}`;
    if (da != null && db != null && Math.abs(da - db) >= 1) {
      readout += ` · ${da > db ? "A" : "B"} ${fmtDistance(Math.abs(da - db))} önde`;
    }
  }

  const row = (label: string, f: FileEntry) => {
    const s = f.summary.stats;
    return (
      <tr>
        <td>
          <span className="swatch" style={{ background: f.color }} /> {label}
        </td>
        <td>{name(f)}</td>
        <td>{fmtDistance(s.distanceM)}</td>
        <td>{fmtDuration(s.movingMs)}</td>
        <td>{fmtSpeed(s.avgMovingSpeedMs)}</td>
        <td>{fmtUnit(s.elevationGainM, "m")}</td>
        <td>{s.avgHr != null ? fmtUnit(s.avgHr, "atım/dk") : "—"}</td>
      </tr>
    );
  };

  return (
    <section className="detail compare" style={{ height }}>
      <header className="detail-header">
        <div className="detail-title">
          <h2>İki kaydı karşılaştır</h2>
        </div>
        <label className="inline-select">
          Ölçü
          <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
            {options.map((m) => (
              <option key={m} value={m}>
                {METRICS[m].label}
              </option>
            ))}
          </select>
        </label>
        <div className="play">
          <button
            className="btn small primary"
            disabled={!ea || !eb}
            onClick={() => {
              if (!playing && playT != null && ea && eb && playT >= Math.max(ea[ea.length - 1], eb[eb.length - 1])) setPlayT(0);
              setPlaying((v) => !v);
            }}
            title={!ea || !eb ? "Oynatmak için iki kayıtta da zaman bilgisi gerekir" : "Aynı anda başlamış gibi oynat"}
          >
            {playing ? "❚❚ Duraklat" : "▶ Yarıştır"}
          </button>
          <select value={playSpeed} onChange={(e) => onPlaySpeed(Number(e.target.value))} title="Oynatma hızı">
            {PLAY_SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
          {playT != null && (
            <button className="btn small" onClick={() => (setPlaying(false), setPlayT(null))}>
              Sıfırla
            </button>
          )}
        </div>
        <button className="icon-btn" onClick={onClose} title="Kapat (Esc)">
          ×
        </button>
      </header>
      <div className="compare-body">
        <table className="data-table compact">
          <thead>
            <tr>
              <th></th>
              <th>Kayıt</th>
              <th>Mesafe</th>
              <th>Hareket</th>
              <th>Ort. hız</th>
              <th>Tırmanış</th>
              <th>Ort. nabız</th>
            </tr>
          </thead>
          <tbody>
            {row("A", a)}
            {row("B", b)}
          </tbody>
        </table>
        <div className="readout">{readout ?? <span className="muted">Grafikte gezinin ya da “Yarıştır”a basın.</span>}</div>
        <div className="chart-area">
          {ready ? <div ref={host} className="chart" /> : <div className="chart-empty">Kayıtlar hazırlanıyor…</div>}
        </div>
      </div>
    </section>
  );
}
