import { useMemo, useState } from "react";
import { dayBuckets, dedupedDays, dedupedTotals } from "../days";
import { flightsOf, uniqueFlights } from "../flights";
import { dayKey, fmtDistance, fmtDuration, fmtElevation, fmtNumber, MONTHS, tzOf } from "../format";
import { visitedPlaces } from "../summary";
import type { FileEntry } from "../types";

interface YearTotals {
  distanceM: number;
  movingMs: number;
  days: number;
  records: number;
  gainM: number;
  countries: number;
  flights: number;
  months: number[];
}

function yearTotals(files: FileEntry[], year: string): YearTotals {
  const [from, to] = [`${year}-01-01`, `${year}-12-31`];
  const inYear = files.filter((f) => dayBuckets(f.summary).some((d) => d.day.startsWith(year)));
  const sums = inYear.map((f) => f.summary);
  const t = dedupedTotals(sums, from, to);
  const months = new Array(12).fill(0);
  for (const [day, v] of dedupedDays(sums)) if (day.startsWith(year)) months[Number(day.slice(5, 7)) - 1] += v.distanceM;
  return {
    distanceM: t.distanceM,
    movingMs: t.movingMs,
    days: t.days,
    records: inYear.length,
    gainM: t.gainM,
    countries: visitedPlaces(inYear, from, to).years.find((y) => y.year === year)?.countries.length ?? 0,
    flights: uniqueFlights(sums.flatMap((s) => flightsOf(s).filter((x) => dayKey(x.start, tzOf(s)).startsWith(year)))).length,
    months,
  };
}

/** Özet'te iki yılın yan yana karşılaştırması. */
export function YearCompareSection({ files }: { files: FileEntry[] }) {
  const years = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) for (const d of dayBuckets(f.summary)) set.add(d.day.slice(0, 4));
    return [...set].sort().reverse();
  }, [files]);
  const [ya, setYa] = useState(years[1] ?? years[0] ?? "");
  const [yb, setYb] = useState(years[0] ?? "");
  const a = useMemo(() => (years.includes(ya) ? yearTotals(files, ya) : null), [files, ya, years]);
  const b = useMemo(() => (years.includes(yb) ? yearTotals(files, yb) : null), [files, yb, years]);
  if (years.length < 2) return null;
  const rows: [string, (t: YearTotals) => number, (v: number) => string][] = [
    ["Mesafe", (t) => t.distanceM, fmtDistance],
    ["Hareket süresi", (t) => t.movingMs, fmtDuration],
    ["Etkin gün", (t) => t.days, fmtNumber],
    ["Kayıt", (t) => t.records, fmtNumber],
    ["Tırmanış", (t) => t.gainM, (v) => fmtElevation(v)],
    ["Ülke", (t) => t.countries, fmtNumber],
    ["Uçuş", (t) => t.flights, fmtNumber],
  ];
  const diff = (x: number, y: number) => {
    if (!x && !y) return "";
    if (!x) return "yeni";
    const p = Math.round(((y - x) / x) * 100);
    return `${p > 0 ? "+" : ""}%${fmtNumber(p)}`;
  };
  const max = Math.max(1, ...(a?.months ?? []), ...(b?.months ?? []));
  const pick = (v: string, set: (y: string) => void) => (
    <select value={v} onChange={(e) => set(e.target.value)} style={{ width: "auto", flex: "0 0 auto" }}>
      {years.map((y) => (
        <option key={y}>{y}</option>
      ))}
    </select>
  );
  return (
    <>
      <h3 className="chart-title">Yılları karşılaştır</h3>
      <div className="filter-row" style={{ alignItems: "center" }}>
        {pick(ya, setYa)} <span>ile</span> {pick(yb, setYb)}
      </div>
      {a && b && (
        <>
          <table className="data-table compact">
            <thead>
              <tr>
                <th></th>
                <th>{ya}</th>
                <th>{yb}</th>
                <th>Fark</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, get, fmt]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{fmt(get(a))}</td>
                  <td>{fmt(get(b))}</td>
                  <td className={get(b) >= get(a) ? "up" : "down"}>{diff(get(a), get(b))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <svg viewBox="0 0 240 70" className="year-compare-chart" role="img" aria-label="Aylara göre mesafe">
            {a.months.map((v, i) => {
              const h = (m: number) => (m / max) * 56;
              return (
                <g key={i}>
                  <rect x={i * 20 + 3} width={6.5} y={58 - h(v)} height={h(v)} className="yc-a">
                    <title>{`${MONTHS[i]} ${ya}: ${fmtDistance(v)}`}</title>
                  </rect>
                  <rect x={i * 20 + 10.5} width={6.5} y={58 - h(b.months[i])} height={h(b.months[i])} className="yc-b">
                    <title>{`${MONTHS[i]} ${yb}: ${fmtDistance(b.months[i])}`}</title>
                  </rect>
                  <text x={i * 20 + 10} y={67} textAnchor="middle">
                    {MONTHS[i].slice(0, 3)}
                  </text>
                </g>
              );
            })}
          </svg>
          <p className="muted small-note">
            <span className="sw-inline yc-a-bg" /> {ya} <span className="sw-inline yc-b-bg" /> {yb} · aylara göre mesafe (kopyalar bir kez)
          </p>
        </>
      )}
    </>
  );
}
