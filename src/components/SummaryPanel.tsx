import { useMemo, useState } from "react";
import type { FileEntry } from "../types";
import {
  MONTHS,
  dayKey,
  fmtDate,
  fmtDistance,
  fmtDuration,
  fmtElevation,
  fmtNumber,
  fmtSpeed,
  monthLabel,
  tzOf,
} from "../format";
import { periodRange } from "./DateRange";
import { Modal } from "./Modal";
import { CalendarHeatmap } from "./CalendarHeatmap";
import { ACTIVITIES, placeLabel } from "../types";
import type { Route } from "../routes";

type Period = "month" | "year";
type Measure = "distance" | "moving" | "gain" | "count";

const MEASURES: { id: Measure; label: string; fmt(v: number): string; axis(v: number): string }[] = [
  { id: "distance", label: "Mesafe", fmt: (v) => fmtDistance(v), axis: (v) => `${fmtNumber(v / 1000)} km` },
  { id: "moving", label: "Hareket süresi", fmt: (v) => fmtDuration(v), axis: (v) => `${fmtNumber(v / 3_600_000)} sa` },
  { id: "gain", label: "Tırmanış", fmt: (v) => fmtElevation(v), axis: (v) => `${fmtNumber(v)} m` },
  { id: "count", label: "Kayıt sayısı", fmt: (v) => `${fmtNumber(v)} kayıt`, axis: (v) => fmtNumber(v) },
];

interface Bucket {
  key: string;
  label: string;
  short: string;
  distance: number;
  moving: number;
  gain: number;
  count: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

interface Props {
  files: FileEntry[];
  routes: Route[];
  onPeriod(from: string, to: string): void;
  onOpen(path: string): void;
  onRoute(route: Route): void;
  onActivity(id: string): void;
  onClose(): void;
}

export function SummaryPanel({ files, routes, onPeriod, onOpen, onRoute, onActivity, onClose }: Props) {
  const [period, setPeriod] = useState<Period>("month");
  const [measure, setMeasure] = useState<Measure>("distance");
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const dated = useMemo(() => files.filter((f) => f.summary.stats.startTime != null), [files]);

  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>();
    for (const f of dated) {
      const s = f.summary;
      const day = dayKey(s.stats.startTime!, tzOf(s));
      const key = period === "month" ? day.slice(0, 7) : day.slice(0, 4);
      let b = map.get(key);
      if (!b) {
        b = { key, label: "", short: "", distance: 0, moving: 0, gain: 0, count: 0 };
        map.set(key, b);
      }
      b.distance += s.stats.distanceM;
      b.moving += s.stats.movingMs ?? 0;
      b.gain += s.stats.elevationGainM ?? 0;
      b.count += 1;
    }
    if (map.size === 0) return [];
    // Boş dönemler de eksende yer alsın ki aralar görünsün.
    const keys = [...map.keys()].sort();
    const out: Bucket[] = [];
    const empty = (key: string): Bucket => ({ key, label: "", short: "", distance: 0, moving: 0, gain: 0, count: 0 });
    if (period === "year") {
      for (let y = Number(keys[0]); y <= Number(keys[keys.length - 1]); y++) out.push(map.get(String(y)) ?? empty(String(y)));
    } else {
      let [y, m] = keys[0].split("-").map(Number);
      const [ey, em] = keys[keys.length - 1].split("-").map(Number);
      while (y < ey || (y === ey && m <= em)) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        out.push(map.get(key) ?? empty(key));
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }
    for (const b of out) {
      if (period === "year") {
        b.label = b.key;
        b.short = b.key;
      } else {
        b.label = monthLabel(b.key);
        const mi = Number(b.key.slice(5)) - 1;
        b.short = mi === 0 ? `${MONTHS[0].slice(0, 3)} ${b.key.slice(2, 4)}` : MONTHS[mi].slice(0, 3);
      }
    }
    return out;
  }, [dated, period]);

  const totals = useMemo(() => {
    let distance = 0,
      moving = 0,
      gain = 0;
    const days = new Set<string>();
    for (const f of files) {
      const s = f.summary.stats;
      distance += s.distanceM;
      moving += s.movingMs ?? 0;
      gain += s.elevationGainM ?? 0;
      if (s.startTime != null) days.add(dayKey(s.startTime, tzOf(f.summary)));
    }
    return { distance, moving, gain, days: days.size, count: files.length };
  }, [files]);

  const records = useMemo(() => {
    const best = (score: (f: FileEntry) => number | null) => {
      let top: FileEntry | null = null;
      let v = -Infinity;
      for (const f of files) {
        const x = score(f);
        if (x != null && x > v) {
          v = x;
          top = f;
        }
      }
      return top;
    };
    const rows: { label: string; f: FileEntry | null; value: (f: FileEntry) => string }[] = [
      { label: "En uzun mesafe", f: best((f) => f.summary.stats.distanceM), value: (f) => fmtDistance(f.summary.stats.distanceM) },
      { label: "En uzun süre", f: best((f) => f.summary.stats.movingMs), value: (f) => fmtDuration(f.summary.stats.movingMs) },
      {
        label: "En hızlı (ort., 1 km üstü)",
        f: best((f) => (f.summary.stats.distanceM >= 1000 ? f.summary.stats.avgMovingSpeedMs : null)),
        value: (f) => fmtSpeed(f.summary.stats.avgMovingSpeedMs),
      },
      { label: "En çok tırmanış", f: best((f) => f.summary.stats.elevationGainM), value: (f) => fmtElevation(f.summary.stats.elevationGainM) },
      { label: "En yüksek nokta", f: best((f) => f.summary.stats.maxEleM), value: (f) => fmtElevation(f.summary.stats.maxEleM) },
    ];
    return rows.filter((r) => r.f);
  }, [files]);

  const m = MEASURES.find((x) => x.id === measure)!;
  const val = (b: Bucket) => b[measure];
  const max = niceMax(Math.max(0, ...buckets.map(val)));
  const peak = buckets.reduce((bi, b, i) => (val(b) > val(buckets[bi] ?? b) ? i : bi), 0);

  // Grafik ölçüleri
  const slot = period === "month" ? 34 : 64;
  const padL = 56;
  const padB = 26;
  const padT = 18;
  const h = 220;
  const w = Math.max(560, padL + buckets.length * slot + 8);
  const barW = Math.min(24, slot * 0.7);
  const y = (v: number) => padT + (h - padT - padB) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  const pick = (b: Bucket) => {
    const [yy, mm] = b.key.split("-").map(Number);
    onPeriod(...periodRange(yy, period === "month" ? mm - 1 : null));
  };

  return (
    <Modal title="Özet" onClose={onClose} wide>
      <div className="summary">
        <div className="tiles">
          <div className="tile">
            <span>Kayıt</span>
            <strong>{fmtNumber(totals.count)}</strong>
          </div>
          <div className="tile">
            <span>Etkin gün</span>
            <strong>{fmtNumber(totals.days)}</strong>
          </div>
          <div className="tile">
            <span>Toplam mesafe</span>
            <strong>{fmtDistance(totals.distance)}</strong>
          </div>
          <div className="tile">
            <span>Hareket süresi</span>
            <strong>{fmtDuration(totals.moving)}</strong>
          </div>
          <div className="tile">
            <span>Toplam tırmanış</span>
            <strong>{fmtElevation(totals.gain)}</strong>
          </div>
          <div className="tile">
            <span>Kayıt başına</span>
            <strong>{fmtDistance(totals.count ? totals.distance / totals.count : 0)}</strong>
          </div>
        </div>
        <p className="muted small-note">Kenar çubuğundaki filtreye uyan {fmtNumber(files.length)} kayıt.</p>

        <div className="type-tiles">
          {ACTIVITIES.map((a) => {
            const list = files.filter((f) => f.summary.activity === a.id);
            if (!list.length) return null;
            const dist = list.reduce((x, f) => x + f.summary.stats.distanceM, 0);
            return (
              <button key={a.id} className="type-tile" onClick={() => onActivity(a.id)} title="Listeyi bu türe süz">
                <span>
                  {a.icon} {a.label}
                </span>
                <strong>{fmtNumber(list.length)}</strong>
                <small>{fmtDistance(dist)}</small>
              </button>
            );
          })}
        </div>

        <h3 className="chart-title">Takvim</h3>
        <CalendarHeatmap files={files} onDay={(iso) => onPeriod(iso, iso)} />

        <div className="filter-row summary-controls">
          <div className="segmented small">
            <button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>
              Aylık
            </button>
            <button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>
              Yıllık
            </button>
          </div>
          <div className="segmented small">
            {MEASURES.map((x) => (
              <button key={x.id} className={measure === x.id ? "active" : ""} onClick={() => setMeasure(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} />
            Tablo olarak
          </label>
        </div>

        <h3 className="chart-title">
          {period === "month" ? "Aylık" : "Yıllık"} {m.label.toLocaleLowerCase("tr-TR")}
        </h3>
        {buckets.length === 0 ? (
          <div className="chart-empty">Tarihli kayıt yok.</div>
        ) : asTable ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Dönem</th>
                  <th>Kayıt</th>
                  <th>Mesafe</th>
                  <th>Hareket süresi</th>
                  <th>Tırmanış</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.key} onClick={() => b.count && pick(b)} className={b.count ? "clickable" : ""}>
                    <td>{b.label}</td>
                    <td>{fmtNumber(b.count)}</td>
                    <td>{fmtDistance(b.distance)}</td>
                    <td>{fmtDuration(b.moving)}</td>
                    <td>{fmtElevation(b.gain)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bars-wrap">
            <svg width={w} height={h} role="img" aria-label={`${m.label} dönemlere göre`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={padL} x2={w - 4} y1={y(t)} y2={y(t)} className="grid" />
                  <text x={padL - 6} y={y(t) + 4} className="axis" textAnchor="end">
                    {m.axis(t)}
                  </text>
                </g>
              ))}
              {buckets.map((b, i) => {
                const v = val(b);
                const x = padL + i * slot + (slot - barW) / 2;
                const top = y(v);
                const bh = h - padB - top;
                const r = Math.min(4, bh);
                const path =
                  bh <= 0
                    ? ""
                    : `M${x},${h - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${h - padB} Z`;
                return (
                  <g
                    key={b.key}
                    className={`bar${hover === i ? " hover" : ""}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => b.count && pick(b)}
                  >
                    {/* Tıklama alanı çubuktan geniş. */}
                    <rect x={padL + i * slot} y={padT} width={slot} height={h - padT - padB} fill="transparent" />
                    {path && <path d={path} />}
                    {(i === peak || hover === i) && v > 0 && (
                      <text x={x + barW / 2} y={top - 5} textAnchor="middle" className="value">
                        {m.fmt(v)}
                      </text>
                    )}
                    <text x={x + barW / 2} y={h - 8} textAnchor="middle" className="axis">
                      {b.short}
                    </text>
                  </g>
                );
              })}
            </svg>
            {hover != null && buckets[hover] && (
              <div className="bar-tip" style={{ left: padL + hover * slot + slot / 2 }}>
                <strong>{buckets[hover].label}</strong>
                <span>{fmtNumber(buckets[hover].count)} kayıt</span>
                <span>{fmtDistance(buckets[hover].distance)}</span>
                <span>{fmtDuration(buckets[hover].moving)}</span>
                <span>↗ {fmtElevation(buckets[hover].gain)}</span>
                {buckets[hover].count > 0 && <em>Tıklayınca bu döneme filtrelenir</em>}
              </div>
            )}
          </div>
        )}

        {routes.length > 0 && (
          <>
            <h3 className="chart-title">Sık güzergâhlar</h3>
            <ul className="records">
              {routes.slice(0, 6).map((r) => {
                const f = files.find((x) => x.summary.path === r.paths[0]) ?? files.find((x) => r.paths.includes(x.summary.path));
                if (!f) return null;
                const timed = r.paths
                  .map((p) => files.find((x) => x.summary.path === p)?.summary.stats.movingMs)
                  .filter((v): v is number => v != null);
                return (
                  <li key={r.id}>
                    <span className="muted">{fmtNumber(r.paths.length)} kez</span>
                    <button className="link" onClick={() => onRoute(r)}>
                      <span className="swatch" style={{ background: f.color }} />
                      {placeLabel(f.summary) ?? f.summary.name ?? f.summary.fileName}
                      <span className="muted"> · {fmtDistance(f.summary.stats.distanceM)}</span>
                    </button>
                    <strong>{timed.length ? `en iyi ${fmtDuration(Math.min(...timed))}` : ""}</strong>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <h3 className="chart-title">Rekorlar</h3>
        <ul className="records">
          {records.map((r) => (
            <li key={r.label}>
              <span className="muted">{r.label}</span>
              <button className="link" onClick={() => onOpen(r.f!.summary.path)}>
                <span className="swatch" style={{ background: r.f!.color }} />
                {r.f!.summary.name || r.f!.summary.fileName}
                <span className="muted"> · {fmtDate(r.f!.summary.stats.startTime, tzOf(r.f!.summary))}</span>
              </button>
              <strong>{r.value(r.f!)}</strong>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
