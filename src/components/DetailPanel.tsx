import { useMemo, useRef, useState } from "react";
import { fmtCo2, fmtFuel, fmtMoney, fuelFor, type FuelPrefs } from "../fuel";
import { nightsOf, type Night } from "../nights";
import type { Detail, FileMeta, FileSummary, NamedPlace, RewriteKind, Stats, Stop } from "../api";
import { namedPlaceAt } from "../places";
import { METRICS, PALETTE, placeLabel, type FileEntry } from "../types";
import { MetaEditor } from "./MetaEditor";
import type { Metric, TrackColorBy, XAxis } from "../prefs";
import {
  fmtBytes,
  fmtDate,
  fmtTime,
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
  isoToTr,
  tzOf,
} from "../format";
import { detailDays } from "../days";
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
  /** Gün seçimi: aralığı seçer ve haritada o güne yakınlaştırır. */
  onPickDay(r: [number, number] | null): void;
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
  /** Kaydı yerinde düzelt (arazi yüksekliği / yola oturtma); geri alınabiliyorsa geri al. */
  onRewrite(kind: RewriteKind): void;
  onUndoRewrite?: () => void;
  rewriting: RewriteKind | null;
  onExportGpx(): void;
  meta: FileMeta;
  allTags: string[];
  onMeta(m: FileMeta): void;
  /** Bu kaydın güzergâhındaki kayıt sayısı (tekrarlanmıyorsa 0). */
  routeCount: number;
  onOpenRoute(): void;
  /** Bu kayıtla zamanı çakışan kayıtlar. */
  overlaps: { path: string; ms: number; name: string; color: string }[];
  onCompareWith(path: string): void;
  places: NamedPlace[];
  onNamePlace(lon: number, lat: number, place: NamedPlace | null): void;
  onFocusPoint(lonLat: [number, number]): void;
  fuel: FuelPrefs;
  onVideo(): void;
}

const STOPS_PAGE = 100;

/** Duraklamaların listesi: tıklayınca harita oraya gider; yerlere ad verilebilir. */
function StopList({
  stops,
  tz,
  multiDay,
  places,
  onNamePlace,
  onFocusPoint,
}: {
  stops: Stop[];
  tz: string | undefined;
  multiDay: boolean;
  places: NamedPlace[];
  onNamePlace(lon: number, lat: number, place: NamedPlace | null): void;
  onFocusPoint(lonLat: [number, number]): void;
}) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(STOPS_PAGE);
  const total = stops.reduce((a, x) => a + x.durationMs, 0);
  return (
    <div className="stop-list">
      <button className="stat stat-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Duraklamaları listele">
        <span>
          Duraklama ({fmtNumber(stops.length)}) {open ? "▾" : "▸"}
        </span>
        <strong>{fmtDuration(total)}</strong>
      </button>
      {open && (
        <ul>
          {stops.slice(0, limit).map((st) => {
            const place = namedPlaceAt(st.lon, st.lat, places);
            return (
              <li key={st.start}>
                <button className="link" onClick={() => onFocusPoint([st.lon, st.lat])} title="Haritada göster">
                  <span className="stop-time">
                    {multiDay && `${fmtDate(st.start, tz).slice(0, 5)} `}
                    {fmtTime(st.start, tz).slice(0, 5)}
                  </span>
                  <span>{fmtDuration(st.durationMs)}</span>
                  {place && <strong className="stop-name">{place.name}</strong>}
                </button>
                <button
                  className="icon-btn tiny"
                  onClick={() => onNamePlace(st.lon, st.lat, place)}
                  title={place ? `“${place.name}” adını değiştir…` : "Bu yere ad ver…"}
                  aria-label={place ? "Adı değiştir" : "Bu yere ad ver"}
                >
                  ✎
                </button>
              </li>
            );
          })}
          {stops.length > limit && (
            <li>
              <button className="link muted" onClick={() => setLimit((l) => l + STOPS_PAGE)}>
                … {fmtNumber(stops.length - limit)} duraklama daha
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Çok günlük kayıtta gece kalınan yerler. */
function NightList({ nights, tz, onFocusPoint }: { nights: Night[]; tz: string | undefined; onFocusPoint(lonLat: [number, number]): void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stop-list">
      <button className="stat stat-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} title="Gece kalınan yerleri listele">
        <span>
          Konaklama {open ? "▾" : "▸"}
        </span>
        <strong>{fmtNumber(nights.length)} gece</strong>
      </button>
      {open && (
        <ul>
          {nights.map((n, i) => (
            <li key={n.start}>
              <button className="link" onClick={() => onFocusPoint([n.lon, n.lat])} title="Haritada göster">
                <span className="stop-time">{i + 1}. gece</span>
                <span>
                  {fmtDate(n.start, tz).slice(0, 5)} {fmtTime(n.start, tz).slice(0, 5)}–{fmtTime(n.end, tz).slice(0, 5)}
                </span>
                {n.place && <strong className="stop-name">{n.place}</strong>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatCards({ st, children }: { st: Stats; children?: React.ReactNode }) {
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
  return (
    <div className="stat-grid">
      {cards.map(([k, v]) => (
        <div className="stat" key={k}>
          <span>{k}</span>
          <strong>{v}</strong>
        </div>
      ))}
      {children}
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

/** Noktaları seyrek kayıt (ortalama 40 m'den uzun adım): yola oturtma
 * önerilir. Sık kayıtlar zaten yolu izliyor. */
function isSparse(s: FileSummary): boolean {
  const n = s.stats.pointCount;
  return n >= 2 && s.stats.distanceM / (n - 1) > 40;
}

export function DetailPanel(p: Props) {
  const s = p.entry.summary;
  const nights = useMemo(() => nightsOf(s, p.places), [s, p.places]);
  const st = s.stats;
  /** Durakta biriken noktaların sadeleştirilmesiyle düşenler (sıçramalardan ayrı). */
  const collapsed = s.collapsedPoints ?? 0;
  const tz = tzOf(s);
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  const available = useMemo(() => (p.detail ? ALL_METRICS.filter((m) => hasMetric(p.detail!, m)) : []), [p.detail]);
  const timeOk = p.detail ? canUseTime(p.detail) : false;
  // Mesafesi olmayan kayıtta (koşu bandı, sabit nabız kaydı) mesafe ekseninde
  // tüm örnekler 0 km'ye yığılır: zaman ekseni kullanılır.
  const distOk = !p.detail || (p.detail.dist[p.detail.dist.length - 1] ?? 0) > 0 || !timeOk;
  const axis = !timeOk ? "dist" : !distOk ? "time" : p.xAxis;
  const d = p.detail;
  const i = p.hoverIdx;
  // Seçili ölçülerin hiçbiri bu kayıtta yoksa (ör. nabız seçili, kayıtta yok) boş
  // grafik yerine kayıttaki ilk uygun ölçü çizilir.
  const chartMetrics = useMemo(() => {
    const own = p.metrics.filter((m) => available.includes(m));
    if (own.length) return own;
    if (available.includes("ele")) return ELE_ONLY;
    return available.length ? available.slice(0, 1) : ELE_ONLY;
  }, [p.metrics, available]);

  // Birden çok güne yayılan kayıtta gün gün gezinme.
  const days = useMemo(() => (d ? detailDays(s, d) : []), [s, d]);
  const dayIdx = p.range ? days.findIndex((x) => x.start === p.range![0] && x.end === p.range![1]) : -1;
  const goDay = (i: number) => {
    const x = days[i];
    p.onPickDay(x ? [x.start, x.end] : null);
  };

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
            {s.removedPoints > 0 && ` · ${fmtNumber(s.removedPoints)} GPS sıçraması ayıklandı`}
            {collapsed > 0 && ` · duraklamalarda ${fmtNumber(collapsed)} nokta sadeleştirildi`}
          </div>
          {placeLabel(s) && <div className="muted place-line">{placeLabel(s)}</div>}
          {p.overlaps.length > 0 && (
            <div className="overlap-line">
              <span>Bu kayıtla çakışan:</span>
              {p.overlaps.slice(0, 3).map((o) => (
                <span key={o.path} className="overlap-item">
                  <span className="swatch" style={{ background: o.color }} />
                  {o.name} ({fmtDuration(o.ms)})
                  <button className="btn tiny" onClick={() => p.onCompareWith(o.path)} title="İki kaydı karşılaştır">
                    Karşılaştır
                  </button>
                </span>
              ))}
              {p.overlaps.length > 3 && <span className="muted">+{p.overlaps.length - 3}</span>}
            </div>
          )}
        </div>
        {p.routeCount > 1 && (
          <button className="btn small" onClick={p.onOpenRoute} title="Aynı güzergâhtaki kayıtları karşılaştır">
            ↻ Bu güzergâh: {p.routeCount} kez
          </button>
        )}
        <button className="btn small" onClick={p.onZoom}>
          Yakınlaştır
        </button>
        {p.onUndoRewrite ? (
          <button className="btn small" onClick={p.onUndoRewrite} title="Kaydın düzeltmeden önceki haline dön">
            ↶ Düzeltmeyi geri al
          </button>
        ) : (
          <>
            <button
              className="btn small"
              onClick={() => p.onRewrite("elevation")}
              disabled={p.rewriting != null}
              title="Telefon GPS'inin gürültülü yüksekliğini arazi yüksekliğiyle (Copernicus DEM, 90 m) değiştirir; tırmanış gerçekçi olur. İnternet gerekir (Open-Meteo). Orijinal dosyanız değişmez; geri alınabilir."
            >
              {p.rewriting === "elevation" ? "Yükseklikler alınıyor…" : "⛰ Yüksekliği düzelt"}
            </button>
            {isSparse(s) && (
              <button
                className="btn small"
                onClick={() => p.onRewrite("snap")}
                disabled={p.rewriting != null}
                title="Seyrek noktalı kaydı (ör. Google konum geçmişi) yollara oturtur: noktalar arası düz çizgiler izlenen yol olur. İnternet gerekir (OpenStreetMap yönlendirme servisi). Orijinal dosyanız değişmez; geri alınabilir."
              >
                {p.rewriting === "snap" ? "Yola oturtuluyor…" : "🛣 Yola oturt"}
              </button>
            )}
          </>
        )}
        <button className="btn small" onClick={p.onExportGpx} title="Farklı kaydet (GPX, KML, TCX, FIT) (Ctrl/⌘+S)">
          Farklı kaydet…
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
        {days.length > 1 && (
          <div className="day-pick" role="group" aria-label="Gün">
            <button
              className="btn small"
              onClick={() => goDay(dayIdx < 0 ? days.length - 1 : dayIdx - 1)}
              disabled={dayIdx === 0}
              title="Önceki gün"
              aria-label="Önceki gün"
            >
              ‹
            </button>
            <select
              value={dayIdx < 0 ? "" : String(dayIdx)}
              onChange={(e) => goDay(e.target.value === "" ? -1 : Number(e.target.value))}
              title="Kaydın bir gününü seç (grafikte ve haritada o gün seçilir)"
            >
              <option value="">Tüm kayıt · {fmtNumber(days.length)} gün</option>
              {days.map((x, k) => (
                <option key={x.day} value={k}>
                  {isoToTr(x.day)} · {fmtDistance(x.distanceM)}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              onClick={() => goDay(dayIdx < 0 ? 0 : dayIdx + 1)}
              disabled={dayIdx === days.length - 1}
              title="Sonraki gün"
              aria-label="Sonraki gün"
            >
              ›
            </button>
          </div>
        )}
        <div className="segmented small" role="group" aria-label="Yatay eksen">
          <button className={axis === "dist" ? "active" : ""} disabled={!distOk} onClick={() => p.onXAxis("dist")}>
            Mesafe
          </button>
          <button
            className={axis === "time" ? "active" : ""}
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
            disabled={!d || d.lat.length < 2}
            title={d && d.lat.length < 2 ? "Oynatmak için en az iki nokta gerekir" : "Oynat / duraklat (Boşluk)"}
          >
            {p.playing ? "❚❚ Duraklat" : "▶ Oynat"}
          </button>
          <button
            className="btn small"
            onClick={p.onVideo}
            disabled={!d || d.lat.length < 2}
            title="Yolculuğu haritada çizerek video olarak kaydet"
          >
            🎥 Video
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
          <strong>{dayIdx >= 0 ? isoToTr(days[dayIdx].day) : "Seçili aralık"}</strong>
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
        <StatCards st={st}>
          {s.stops.length > 0 && (
            <StopList
              stops={s.stops}
              tz={tz}
              multiDay={days.length > 1}
              places={p.places}
              onNamePlace={p.onNamePlace}
              onFocusPoint={p.onFocusPoint}
            />
          )}
          {nights.length > 0 && <NightList nights={nights} tz={tz} onFocusPoint={p.onFocusPoint} />}
          {s.activity === "car" && st.distanceM > 0 && (() => {
            const u = fuelFor(st.distanceM, p.fuel);
            return (
              <div className="stat" title={`Ayarlardaki tüketime göre tahmin: ${fmtFuel(u)}, ${fmtCo2(u.co2Kg)}`}>
                <span>Yakıt (tahmini)</span>
                <strong>
                  {fmtFuel(u)} · {fmtMoney(u.cost)}
                </strong>
              </div>
            );
          })()}
        </StatCards>
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
                metrics={chartMetrics}
                xAxis={axis}
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
