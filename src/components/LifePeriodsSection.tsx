import { useMemo } from "react";
import { fmtNumber, monthLabel } from "../format";
import { lifePeriods } from "../lifePeriods";
import type { FileEntry } from "../types";

const span = (months: number) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y && `${fmtNumber(y)} yıl`, m && `${fmtNumber(m)} ay`].filter(Boolean).join(" ");
};

/** Özet'te yaşam dönemleri: günlerin başladığı yere göre ay ay "ev" ve
 * taşınmalar. Döneme tıklayınca liste o aylara süzülür. */
export function LifePeriodsSection({ files, onPeriod }: { files: FileEntry[]; onPeriod(from: string, to: string): void }) {
  const periods = useMemo(() => lifePeriods(files.map((f) => f.summary)), [files]);
  if (!periods.length) return null;
  return (
    <>
      <h3 className="chart-title">Yaşam dönemleri</h3>
      <ol className="life-periods" data-testid="life-periods">
        {[...periods].reverse().map((p) => {
          const [y, m] = p.to.split("-").map(Number);
          const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
          return (
            <li key={p.from}>
              <button className="link" onClick={() => onPeriod(`${p.from}-01`, `${p.to}-${String(last).padStart(2, "0")}`)} title="Listeyi bu döneme süz">
                {`${monthLabel(p.from)} – ${monthLabel(p.to)}`}
              </button>
              <strong data-no-i18n>{p.place ?? `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`}</strong>
              <span className="muted">{span(p.months)}</span>
            </li>
          );
        })}
      </ol>
      <small className="muted">Günlerin çoğunun başladığı yere göre; geziler ve “evden uzak” hesapları dönemin evine göre yapılır.</small>
    </>
  );
}
