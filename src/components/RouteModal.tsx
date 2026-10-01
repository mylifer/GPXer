import { useMemo, useState } from "react";
import type { FileEntry } from "../types";
import { placeLabel } from "../types";
import type { Route } from "../routes";
import { fmtDate, fmtDistance, fmtDuration, fmtSpeed, tzOf } from "../format";
import { Modal } from "./Modal";

interface Props {
  route: Route;
  files: Map<string, FileEntry>;
  current: string | null;
  onOpen(path: string): void;
  onFilter(): void;
  onClose(): void;
}

/** Aynı güzergâhın tüm kayıtları: süreler zaman içinde, en iyiyle fark. */
export function RouteModal({ route, files, current, onOpen, onFilter, onClose }: Props) {
  const runs = useMemo(
    () =>
      route.paths
        .map((p) => files.get(p))
        .filter((f): f is FileEntry => !!f)
        .sort((a, b) => (a.summary.stats.startTime ?? 0) - (b.summary.stats.startTime ?? 0)),
    [route, files],
  );
  const [hover, setHover] = useState<number | null>(null);
  const timed = runs.filter((f) => f.summary.stats.movingMs);
  const best = timed.reduce<FileEntry | null>(
    (b, f) => (!b || f.summary.stats.movingMs! < b.summary.stats.movingMs! ? f : b),
    null,
  );
  const first = runs[0]?.summary;
  const label = first ? (placeLabel(first) ?? first.name ?? first.fileName) : "";
  const avgDist = runs.reduce((s, f) => s + f.summary.stats.distanceM, 0) / Math.max(1, runs.length);

  // Nokta grafiği: x = tarih, y = hareket süresi.
  const w = 640;
  const h = 170;
  const pad = { l: 56, r: 12, t: 12, b: 24 };
  const ts = timed.map((f) => f.summary.stats.startTime ?? 0);
  const ms = timed.map((f) => f.summary.stats.movingMs!);
  const [t0, t1] = [Math.min(...ts), Math.max(...ts)];
  const [m0, m1] = [Math.min(...ms) * 0.95, Math.max(...ms) * 1.05];
  const xOf = (t: number) => pad.l + (t1 > t0 ? ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r) : (w - pad.l - pad.r) / 2);
  const yOf = (m: number) => pad.t + (m1 > m0 ? (1 - (m - m0) / (m1 - m0)) * (h - pad.t - pad.b) : (h - pad.t - pad.b) / 2);
  const ticks = [m0, (m0 + m1) / 2, m1];

  return (
    <Modal title={`Güzergâh: ${label}`} onClose={onClose} wide>
      <div className="route-modal">
        <p className="muted small-note">
          {runs.length} kayıt · ortalama {fmtDistance(avgDist)}
          {best && ` · en iyi ${fmtDuration(best.summary.stats.movingMs)} (${fmtDate(best.summary.stats.startTime, tzOf(best.summary))})`}
        </p>
        {timed.length > 1 && (
          <div className="bars-wrap">
            <h3 className="chart-title">Hareket süresi, zaman içinde</h3>
            <svg width={w} height={h} role="img" aria-label="Hareket süreleri">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.l} x2={w - pad.r} y1={yOf(t)} y2={yOf(t)} className="grid" />
                  <text x={pad.l - 6} y={yOf(t) + 4} textAnchor="end" className="axis">
                    {fmtDuration(t)}
                  </text>
                </g>
              ))}
              <text x={pad.l} y={h - 6} className="axis">
                {fmtDate(t0)}
              </text>
              <text x={w - pad.r} y={h - 6} textAnchor="end" className="axis">
                {fmtDate(t1)}
              </text>
              {timed.map((f, i) => {
                const s = f.summary;
                const isBest = f === best;
                return (
                  <g
                    key={s.path}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => onOpen(s.path)}
                    className="dot"
                  >
                    <circle cx={xOf(s.stats.startTime ?? 0)} cy={yOf(s.stats.movingMs!)} r={12} fill="transparent" />
                    <circle
                      cx={xOf(s.stats.startTime ?? 0)}
                      cy={yOf(s.stats.movingMs!)}
                      r={hover === i ? 6 : 4.5}
                      className={isBest ? "best" : s.path === current ? "current" : ""}
                    />
                  </g>
                );
              })}
            </svg>
            {hover != null && timed[hover] && (
              <div
                className="bar-tip"
                style={{ left: xOf(timed[hover].summary.stats.startTime ?? 0), top: yOf(timed[hover].summary.stats.movingMs!) + 12 }}
              >
                <strong>{fmtDate(timed[hover].summary.stats.startTime, tzOf(timed[hover].summary))}</strong>
                <span>{fmtDuration(timed[hover].summary.stats.movingMs)}</span>
                <span>{fmtSpeed(timed[hover].summary.stats.avgMovingSpeedMs)}</span>
              </div>
            )}
            <div className="cal-legend">
              <span className="dot-key best" /> <span className="muted">en iyi</span>
              <span className="dot-key current" /> <span className="muted">seçili kayıt</span>
            </div>
          </div>
        )}
        <div className="table-wrap tall">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Hareket süresi</th>
                <th>En iyiden farkı</th>
                <th>Ort. hız</th>
                <th>Mesafe</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((f) => {
                const s = f.summary;
                const diff = best && s.stats.movingMs != null ? s.stats.movingMs - best.summary.stats.movingMs! : null;
                return (
                  <tr
                    key={s.path}
                    className={`clickable${s.path === current ? " current" : ""}`}
                    onClick={() => onOpen(s.path)}
                  >
                    <td>{fmtDate(s.stats.startTime, tzOf(s))}</td>
                    <td>{fmtDuration(s.stats.movingMs)}</td>
                    <td>{diff == null ? "—" : diff === 0 ? "en iyi" : `+${fmtDuration(diff)}`}</td>
                    <td>{fmtSpeed(s.stats.avgMovingSpeedMs)}</td>
                    <td>{fmtDistance(s.stats.distanceM)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="form-actions">
          <button className="btn" onClick={onFilter}>
            Listede yalnızca bu güzergâhı göster
          </button>
        </div>
      </div>
    </Modal>
  );
}
