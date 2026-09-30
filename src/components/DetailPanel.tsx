import type { Detail } from "../api";
import type { FileEntry } from "../types";
import {
  fmtBytes,
  fmtDateTime,
  fmtDistance,
  fmtDuration,
  fmtElevation,
  fmtNumber,
  fmtPace,
  fmtSpeed,
} from "../format";
import { ProfileChart } from "./ProfileChart";

interface Props {
  entry: FileEntry;
  detail: Detail | null;
  detailError: string | null;
  showSpeed: boolean;
  onShowSpeed(v: boolean): void;
  onHover(index: number | null): void;
  onClose(): void;
  onZoom(): void;
}

export function DetailPanel({ entry, detail, detailError, showSpeed, onShowSpeed, onHover, onClose, onZoom }: Props) {
  const s = entry.summary;
  const st = s.stats;
  const cards: [string, string][] = [
    ["Mesafe", fmtDistance(st.distanceM)],
    ["Toplam süre", fmtDuration(st.durationMs)],
    ["Hareket süresi", fmtDuration(st.movingMs)],
    ["Ort. hız", fmtSpeed(st.avgMovingSpeedMs)],
    ["Ort. tempo", fmtPace(st.avgMovingSpeedMs)],
    ["Maks. hız", fmtSpeed(st.maxSpeedMs)],
    ["Tırmanış", fmtElevation(st.elevationGainM)],
    ["İniş", fmtElevation(st.elevationLossM)],
    ["En düşük", fmtElevation(st.minEleM)],
    ["En yüksek", fmtElevation(st.maxEleM)],
  ];

  return (
    <section className="detail">
      <header className="detail-header">
        <span className="swatch" style={{ background: entry.color }} />
        <div className="detail-title">
          <h2>{s.name || s.fileName}</h2>
          <div className="muted">
            {fmtDateTime(st.startTime)} · {s.fileName} · {fmtBytes(s.fileSize)} · {fmtNumber(st.pointCount)} nokta
            {st.segmentCount > 1 && ` · ${st.segmentCount} parça`}
            {s.waypoints.length > 0 && ` · ${s.waypoints.length} işaret`}
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={showSpeed} onChange={(e) => onShowSpeed(e.target.checked)} />
          Hız eğrisi
        </label>
        <button className="btn" onClick={onZoom}>
          Yakınlaştır
        </button>
        <button className="icon-btn" onClick={onClose} title="Kapat (Esc)">
          ×
        </button>
      </header>
      <div className="detail-body">
        <div className="stat-grid">
          {cards.map(([k, v]) => (
            <div className="stat" key={k}>
              <span>{k}</span>
              <strong>{v}</strong>
            </div>
          ))}
        </div>
        <div className="chart-wrap">
          {detail ? (
            <ProfileChart detail={detail} color={entry.color} showSpeed={showSpeed} onHover={onHover} />
          ) : detailError ? (
            <div className="chart-empty error">{detailError}</div>
          ) : (
            <div className="chart-empty">Grafik hazırlanıyor…</div>
          )}
        </div>
      </div>
    </section>
  );
}
