import { useMemo, useState } from "react";
import type { FileEntry } from "../types";
import { SEQ_LIGHT } from "../types";
import { MONTHS, dayKey, fmtDistance, fmtDuration, fmtNumber, isoOf, tzOf } from "../format";

interface Day {
  count: number;
  distance: number;
  moving: number;
}

const CELL = 12;
const GAP = 2;
const WEEKDAY_LABELS = ["Pt", "", "Ça", "", "Cu", "", "Pz"];

interface Props {
  files: FileEntry[];
  onDay(iso: string): void;
}

/** Yıllık takvim: her gün bir kare, koyuluğu o günkü mesafe. */
export function CalendarHeatmap({ files, onDay }: Props) {
  const days = useMemo(() => {
    const m = new Map<string, Day>();
    for (const f of files) {
      const s = f.summary;
      if (s.stats.startTime == null) continue;
      const k = dayKey(s.stats.startTime, tzOf(s));
      const d = m.get(k) ?? { count: 0, distance: 0, moving: 0 };
      d.count++;
      d.distance += s.stats.distanceM;
      d.moving += s.stats.movingMs ?? 0;
      m.set(k, d);
    }
    return m;
  }, [files]);

  const years = useMemo(() => [...new Set([...days.keys()].map((k) => Number(k.slice(0, 4))))].sort((a, b) => b - a), [days]);
  const [year, setYear] = useState<number | null>(null);
  const y = year ?? years[0] ?? new Date().getFullYear();
  const [hover, setHover] = useState<{ iso: string; x: number; y: number } | null>(null);

  // Renk eşikleri: kayıtlı günlerin mesafe dilimleri (aykırı uzun günler skalayı ezmesin).
  const steps = useMemo(() => {
    const v = [...days.values()].map((d) => d.distance).sort((a, b) => a - b);
    if (v.length === 0) return [];
    return [0.2, 0.4, 0.6, 0.8].map((q) => v[Math.min(v.length - 1, Math.floor(v.length * q))]);
  }, [days]);
  const ramp = [SEQ_LIGHT[0], SEQ_LIGHT[2], SEQ_LIGHT[3], SEQ_LIGHT[4], SEQ_LIGHT[6]];
  const colorOf = (dist: number) => ramp[steps.filter((s) => dist > s).length];

  // Pazartesi ile başlayan haftalar.
  const first = new Date(y, 0, 1);
  const offset = (first.getDay() + 6) % 7;
  const total = (new Date(y, 11, 31).getTime() - first.getTime()) / 86_400_000 + 1;
  const cells: { iso: string; col: number; row: number }[] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(y, 0, 1 + i);
    const idx = i + offset;
    cells.push({ iso: isoOf(d), col: Math.floor(idx / 7), row: idx % 7 });
  }
  const weeks = Math.ceil((total + offset) / 7);
  const left = 22;
  const top = 16;
  const width = left + weeks * (CELL + GAP);
  const height = top + 7 * (CELL + GAP);
  const monthStarts = MONTHS.map((name, m) => {
    const idx = Math.round((new Date(y, m, 1).getTime() - first.getTime()) / 86_400_000) + offset;
    return { name: name.slice(0, 3), x: left + Math.floor(idx / 7) * (CELL + GAP) };
  });

  const yearTotals = useMemo(() => {
    let count = 0,
      distance = 0,
      active = 0;
    for (const [k, d] of days) {
      if (!k.startsWith(String(y))) continue;
      count += d.count;
      distance += d.distance;
      active++;
    }
    return { count, distance, active };
  }, [days, y]);

  const hd = hover ? days.get(hover.iso) : undefined;

  return (
    <div className="calendar-heat">
      <div className="filter-row">
        <select value={y} onChange={(e) => setYear(Number(e.target.value))} title="Yıl">
          {(years.length ? years : [y]).map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <span className="muted">
          {fmtNumber(yearTotals.active)} etkin gün · {fmtNumber(yearTotals.count)} kayıt · {fmtDistance(yearTotals.distance)}
        </span>
      </div>
      <div className="bars-wrap">
        <svg width={width} height={height} role="img" aria-label={`${y} takvimi`}>
          {monthStarts.map((m) => (
            <text key={m.name} x={m.x} y={10} className="axis">
              {m.name}
            </text>
          ))}
          {WEEKDAY_LABELS.map((w, i) =>
            w ? (
              <text key={i} x={0} y={top + i * (CELL + GAP) + CELL - 2} className="axis">
                {w}
              </text>
            ) : null,
          )}
          {cells.map((c) => {
            const d = days.get(c.iso);
            return (
              <rect
                key={c.iso}
                x={left + c.col * (CELL + GAP)}
                y={top + c.row * (CELL + GAP)}
                width={CELL}
                height={CELL}
                rx={2}
                className={d ? "day on" : "day"}
                style={d ? { fill: colorOf(d.distance) } : undefined}
                onMouseEnter={() =>
                  setHover({ iso: c.iso, x: left + c.col * (CELL + GAP), y: top + c.row * (CELL + GAP) })
                }
                onMouseLeave={() => setHover(null)}
                onClick={() => d && onDay(c.iso)}
              />
            );
          })}
        </svg>
        {hover && (
          <div className="bar-tip" style={{ left: hover.x + CELL / 2, top: hover.y + CELL + 6 }}>
            <strong>{hover.iso.split("-").reverse().join(".")}</strong>
            {hd ? (
              <>
                <span>
                  {fmtNumber(hd.count)} kayıt · {fmtDistance(hd.distance)}
                </span>
                <span>{fmtDuration(hd.moving)}</span>
                <em>Tıklayınca bu güne süzülür</em>
              </>
            ) : (
              <span className="muted">Kayıt yok</span>
            )}
          </div>
        )}
      </div>
      <div className="cal-legend">
        <span className="muted">Mesafe: az</span>
        {ramp.map((c) => (
          <span key={c} className="cal-swatch" style={{ background: c }} />
        ))}
        <span className="muted">çok</span>
      </div>
    </div>
  );
}
