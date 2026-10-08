import { useMemo, useState } from "react";
import { MONTHS, fmtNumber, isoToTr } from "../format";
import { coverage } from "../coverage";
import { dayBuckets } from "../days";
import type { FileEntry } from "../types";

const GAP_ROWS = 12;
const MIN_GAPS = [7, 14, 30, 90];

/** Özet'te kayıt kapsamı: her yılın her ayında kaç günün kaydı var, ve
 * arşivde hiç kaydı olmayan uzun dönemler (eksik GPS'i bulmak için). */
export function CoverageSection({ files, onPeriod }: { files: FileEntry[]; onPeriod(from: string, to: string): void }) {
  const [minGap, setMinGap] = useState(14);
  const c = useMemo(() => coverage(files.flatMap((f) => dayBuckets(f.summary).map((b) => b.day)), minGap), [files, minGap]);
  if (!c.recorded) return null;
  const pct = Math.round((c.recorded / c.span) * 100);
  return (
    <>
      <h3 className="chart-title">{`Kayıt kapsamı: ${fmtNumber(c.span)} günün ${fmtNumber(c.recorded)} gününde kayıt var (%${pct})`}</h3>
      <div className="bars-wrap">
        <table className="coverage" data-testid="coverage">
          <thead>
            <tr>
              <th />
              {MONTHS.map((m) => (
                <th key={m}>{m.slice(0, 3)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.years.map(([y, months]) => (
              <tr key={y}>
                <th>{y}</th>
                {months.map(([n, total], m) => {
                  const mm = String(m + 1).padStart(2, "0");
                  return (
                    <td key={m}>
                      <button
                        className="cov-cell"
                        style={{ opacity: n ? 0.25 + (0.75 * n) / total : 1 }}
                        data-on={n > 0 || undefined}
                        title={`${MONTHS[m]} ${y}: ${n} / ${total} gün`}
                        disabled={!n}
                        onClick={() => onPeriod(`${y}-${mm}-01`, `${y}-${mm}-${String(total).padStart(2, "0")}`)}
                      >
                        {n || ""}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="filter-row">
        <span className="muted">Kayıtsız dönemler, en az</span>
        <select value={minGap} onChange={(e) => setMinGap(Number(e.target.value))} aria-label="En kısa boşluk">
          {MIN_GAPS.map((n) => (
            <option key={n} value={n}>{`${n} gün`}</option>
          ))}
        </select>
      </div>
      {c.gaps.length === 0 ? (
        <p className="muted">Bu uzunlukta kayıtsız dönem yok.</p>
      ) : (
        <ul className="coverage-gaps" data-testid="coverage-gaps">
          {c.gaps.slice(0, GAP_ROWS).map((g) => (
            <li key={g.from}>
              <span>{`${isoToTr(g.from)} – ${isoToTr(g.to)}`}</span>
              <span className="muted">{`${fmtNumber(g.days)} gün`}</span>
            </li>
          ))}
          {c.gaps.length > GAP_ROWS && <li className="muted">{`… ve ${fmtNumber(c.gaps.length - GAP_ROWS)} dönem daha`}</li>}
        </ul>
      )}
    </>
  );
}
