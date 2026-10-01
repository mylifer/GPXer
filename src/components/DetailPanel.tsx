import { useRef, useState } from "react";
import type { Detail, FileMeta, Stats, Stop } from "../api";
import { METRICS, PALETTE, placeLabel, type FileEntry } from "../types";
import { MetaEditor } from "./MetaEditor";
import type { Metric, TrackColorBy, XAxis } from "../prefs";
import {
  fmtBytes,
  fmtDateTime,
  fmtDistance,
  fmtDuration,
  fmtElevation,
  fmtKmh,
  fmtNumber,
  fmtPace,
  fmtSpeed,
  fmtTimestamp,
  fmtUnit,
  tzOf,
} from "../format";
import { ProfileChart, canUseTime, hasMetric, metricValues } from "./ProfileChart";

const ALL_METRICS: Metric[] = ["ele", "speed", "hr", "cad", "power", "temp"];
/** Hiçbir ölçü seçili değilse yükseklik gösterilir (sabit dizi: grafik boşuna yeniden kurulmasın). */
const ELE_ONLY: Metric[] = ["ele"];
export const PLAY_SPEEDS = [10, 30, 60, 120, 300, 600];

interface Props {
  entry: FileEntry;
  detail: Detail | null;
  detailError: string | null;
  height: number;
  onResize(h: number): void;
  metrics: Metric[];
  onMetrics(m: Metric[]): void;
  xAxis: XAxis;
  onXAxis(x: XAxis): void;
  trackColorBy: TrackColorBy;
  onTrackColorBy(c: TrackColorBy): void;
  hoverIdx: number | null;
  onHover(index: number | null): void;
  range: [number, number] | null;
  onRange(r: [number, number] | null): void;
  rangeStats: Stats | null;
  onZoomRange(): void;
  onTrim(): void;
  onSplit(): void;
  playing: boolean;
  onPlay(): void;
  playSpeed: number;
  onPlaySpeed(v: number): void;
  follow: boolean;
  onFollow(v: boolean): void;
  onColor(c: string): void;
  onClose(): void;
  onZoom(): void;
  onExportGpx(): void;
  meta: FileMeta;
  allTags: string[];
  onMeta(m: FileMeta): void;
  /** Bu kaydın güzergâhındaki kayıt sayısı (tekrarlanmıyorsa 0). */
  routeCount: number;
  onOpenRoute(): void;
}

function StatCards({ st, stops }: { st: Stats; stops?: Stop[] }) {
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
  if (st.avgHr != null) cards.push(["Ort. nabız", fmtUnit(st.avgHr, "atım/dk")], ["Maks. nabız", fmtUnit(st.maxHr, "atım/dk")]);
  if (st.avgCad != null) cards.push(["Ort. kadans", fmtUnit(st.avgCad, "dev/dk")]);
  if (st.avgPower != null) cards.push(["Ort. güç", fmtUnit(st.avgPower, "W")], ["Maks. güç", fmtUnit(st.maxPower, "W")]);
  if (st.avgTemp != null) cards.push(["Ort. sıcaklık", fmtUnit(st.avgTemp, "°C", 1)]);
  if (stops?.length) {
    const total = stops.reduce((a, x) => a + x.durationMs, 0);
    cards.push([`Duraklama (${stops.length})`, fmtDuration(total)]);
  }
  return (
    <div className="stat-grid">
      {cards.map(([k, v]) => (
        <div className="stat" key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
    </div>
  );
}

function ColorPicker({ color, onColor }: { color: string; onColor(c: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="color-picker">
      <button
        className="swatch big"
        style={{ background: color }}
        onClick={() => setOpen((v) => !v)}
        title="Rengi değiştir"
        aria-label="Rengi değiştir"
      />
      {open && (
        <div className="color-pop" onMouseLeave={() => setOpen(false)}>
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`swatch big${c === color ? " picked" : ""}`}
              style={{ background: c }}
              onClick={() => {
                onColor(c);
                setOpen(false);
              }}
              aria-label={c}
            />
          ))}
          <input type="color" value={color} onChange={(e) => onColor(e.target.value)} title="Özel renk" />
        </div>
      )}
    </div>
  );
}

export function DetailPanel(p: Props) {
  const s = p.entry.summary;
  const st = s.stats;
  const tz = tzOf(s);
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  const available = p.detail ? ALL_METRICS.filter((m) => hasMetric(p.detail!, m)) : [];
  const timeOk = p.detail ? canUseTime(p.detail) : false;
  const d = p.detail;
  const i = p.hoverIdx;

  const toggleMetric = (m: Metric) => {
    const next = p.metrics.includes(m) ? p.metrics.filter((x) => x !== m) : [...p.metrics, m];
    p.onMetrics(ALL_METRICS.filter((x) => next.includes(x)));
  };

  const onResizeStart = (e: React.PointerEvent) => {
    dragStart.current = { y: e.clientY, h: p.height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onResizeMove = (e: React.PointerEvent) => {
    if (!dragStart.current) return;
    const max = Math.round(window.innerHeight * 0.75);
    p.onResize(Math.max(200, Math.min(max, dragStart.current.h + dragStart.current.y - e.clientY)));
  };

  return (
    <section className="detail" style={{ height: p.height }}>
      <div
        className="resize-handle"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={() => (dragStart.current = null)}
        title="Paneli boyutlandırmak için sürükleyin"
      />
      <header className="detail-header">
        <ColorPicker color={p.entry.color} onColor={p.onColor} />
        <div className="detail-title">
          <h2>{s.name || s.fileName}</h2>
          <div className="muted">
            {fmtDateTime(st.startTime, tz)}
            {tz && ` (${tz})`} · {s.fileName} · {fmtBytes(s.fileSize)} · {fmtNumber(st.pointCount)} nokta
            {st.segmentCount > 1 && ` · ${st.segmentCount} parça`}
            {s.waypoints.length > 0 && ` · ${s.waypoints.length} işaret`}
            {s.removedPoints > 0 && ` · ${s.removedPoints} GPS sıçraması ayıklandı`}
          </div>
          {placeLabel(s) && <div className="muted place-line">{placeLabel(s)}</div>}
        </div>
        {p.routeCount > 1 && (
          <button className="btn small" onClick={p.onOpenRoute} title="Aynı güzergâhtaki kayıtları karşılaştır">
            ↻ Bu güzergâh: {p.routeCount} kez
          </button>
        )}
        <button className="btn small" onClick={p.onZoom}>
          Yakınlaştır
        </button>
        <button className="btn small" onClick={p.onExportGpx} title="GPX, KML ya da TCX olarak kaydet (Ctrl/⌘+S)">
          Kaydet…
        </button>
        <button className="icon-btn" onClick={p.onClose} title="Kapat (Esc)">
          ×
        </button>
      </header>
      <MetaEditor summary={s} meta={p.meta} allTags={p.allTags} onChange={p.onMeta} />
      <div className="detail-toolbar">
        <div className="chips" role="group" aria-label="Grafikte gösterilecekler">
          {ALL_METRICS.filter((m) => available.includes(m)).map((m) => (
            <label key={m} className={`chip${p.metrics.includes(m) ? " on" : ""}`}>
              <input type="checkbox" checked={p.metrics.includes(m)} onChange={() => toggleMetric(m)} />
              {METRICS[m].label}
            </label>
          ))}
        </div>
        <div className="segmented small" role="group" aria-label="Yatay eksen">
          <button className={p.xAxis === "dist" ? "active" : ""} onClick={() => p.onXAxis("dist")}>
            Mesafe
          </button>
          <button
            className={p.xAxis === "time" ? "active" : ""}
            disabled={!timeOk}
            onClick={() => p.onXAxis("time")}
            title={timeOk ? undefined : "Bu kayıtta her noktada zaman bilgisi yok"}
          >
            Zaman
          </button>
        </div>
        <label className="inline-select">
          İzi renklendir
          <select value={p.trackColorBy} onChange={(e) => p.onTrackColorBy(e.target.value as TrackColorBy)}>
            <option value="none">Düz renk</option>
            {available.map((m) => (
              <option key={m} value={m}>
                {METRICS[m].label}
              </option>
            ))}
          </select>
        </label>
        <div className="play">
          <button
            className="btn small primary"
            onClick={p.onPlay}
            disabled={!d}
            title="Oynat / duraklat (Boşluk)"
          >
            {p.playing ? "❚❚ Duraklat" : "▶ Oynat"}
          </button>
          <select value={p.playSpeed} onChange={(e) => p.onPlaySpeed(Number(e.target.value))} title="Oynatma hızı">
            {PLAY_SPEEDS.map((v) => (
              <option key={v} value={v}>
                {v}×
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={p.follow} onChange={(e) => p.onFollow(e.target.checked)} />
            Takip et
          </label>
        </div>
      </div>

      {p.range && (
        <div className="range-bar">
          <strong>Seçili aralık</strong>
          {p.rangeStats ? (
            <span className="range-stats">
              {fmtDistance(p.rangeStats.distanceM)} · {fmtDuration(p.rangeStats.durationMs)} ·{" "}
              {fmtSpeed(p.rangeStats.avgMovingSpeedMs)} · ↗ {fmtElevation(p.rangeStats.elevationGainM)} · ↘{" "}
              {fmtElevation(p.rangeStats.elevationLossM)}
              {p.rangeStats.avgHr != null && ` · ♥ ${fmtUnit(p.rangeStats.avgHr, "atım/dk")}`}
            </span>
          ) : (
            <span className="muted">hesaplanıyor…</span>
          )}
          <span className="spacer" />
          <button className="btn small" onClick={p.onZoomRange}>
            Haritada göster
          </button>
          <button className="btn small" onClick={p.onTrim} title="Aralığı yeni kayıt olarak kaydet">
            Kırp
          </button>
          <button className="btn small" onClick={p.onSplit} title="Kaydı aralığın başından ikiye böl">
            Buradan böl
          </button>
          <button className="icon-btn" onClick={() => p.onRange(null)} title="Seçimi kaldır (çift tıklama)">
            ×
          </button>
        </div>
      )}

      <div className="detail-body">
        <StatCards st={st} stops={s.stops} />
        <div className="chart-wrap">
          <div className="readout" aria-live="off">
            {d && i != null && i < d.dist.length ? (
              <>
                <span>{fmtTimestamp(d.time[i], tz)}</span>
                <span>{fmtDistance(d.dist[i])}</span>
                {available.map((m) => {
                  const v = metricValues(d, m)[i];
                  const meta = METRICS[m];
                  return (
                    <span key={m}>
                      {meta.label}:{" "}
                      <strong>{m === "speed" ? fmtKmh(v) : fmtUnit(v, meta.unit, meta.digits)}</strong>
                    </span>
                  );
                })}
              </>
            ) : (
              <span className="muted">
                Grafikte ya da haritada iz üzerinde gezinin. Aralık seçmek için grafikte sürükleyin.
              </span>
            )}
          </div>
          <div className="chart-area">
            {d ? (
              <ProfileChart
                detail={d}
                color={p.entry.color}
                metrics={p.metrics.length ? p.metrics : ELE_ONLY}
                xAxis={timeOk ? p.xAxis : "dist"}
                tz={tz}
                hoverIdx={p.hoverIdx}
                range={p.range}
                onHover={p.onHover}
                onRange={p.onRange}
              />
            ) : p.detailError ? (
              <div className="chart-empty error">{p.detailError}</div>
            ) : (
              <div className="chart-empty">Grafik hazırlanıyor…</div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
