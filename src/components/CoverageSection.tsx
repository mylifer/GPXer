import { useMemo, useState } from "react";
import { MONTHS, fmtNumber, isoToTr } from "../format";
import { coverage, type Gap } from "../coverage";
import type { PhotoInfo } from "../api";
import { photoDay } from "../photos";
import { dayBuckets } from "../days";
import type { FileEntry } from "../types";

const GAP_ROWS = 12;

export interface CoverageFill {
  photos: readonly PhotoInfo[];
  onPhotoTrack(from: string, to: string): void;
  onImport(): void;
  quiet: string[];
  onQuiet(list: string[]): void;
}
const MIN_GAPS = [7, 14, 30, 90];

/** Özet'te kayıt kapsamı: her yılın her ayında kaç günün kaydı var, ve
 * arşivde hiç kaydı olmayan uzun dönemler (eksik GPS'i bulmak için). */
export function CoverageSection({
  files,
  onPeriod,
  fill,
}: {
  files: FileEntry[];
  onPeriod(from: string, to: string): void;
  /** Boşlukları doldurma: fotoğraflar, iz oluşturma, içe aktarma, "bilerek boş". */
  fill?: CoverageFill;
}) {
  const [minGap, setMinGap] = useState(14);
  const [showQuiet, setShowQuiet] = useState(false);
  const c = useMemo(() => coverage(files.flatMap((f) => dayBuckets(f.summary).map((b) => b.day)), minGap), [files, minGap]);
  const quiet = useMemo(() => (fill?.quiet ?? []).map((q) => q.split("/") as [string, string]), [fill?.quiet]);
  const isQuiet = (g: Gap) => quiet.some(([a, b]) => a <= g.from && g.to <= b);
  // Boşlukta çekilmiş, konumu olan fotoğraf sayısı (iz oluşturmak için en az iki).
  const photoDays = useMemo(
    () => (fill?.photos ?? [])
        .filter((p) => p.lat != null)
        .map(photoDay)
        .filter((d): d is string => d != null)
        .sort(),
    [fill?.photos],
  );
  const photosIn = (g: Gap) => photoDays.filter((d) => d >= g.from && d <= g.to).length;
  if (!c.recorded) return null;
  const gaps = c.gaps.filter((g) => showQuiet || !isQuiet(g));
  const quietCount = c.gaps.length - c.gaps.filter((g) => !isQuiet(g)).length;
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
      {gaps.length === 0 ? (
        <p className="muted">Bu uzunlukta kayıtsız dönem yok.</p>
      ) : (
        <ul className="coverage-gaps" data-testid="coverage-gaps">
          {gaps.slice(0, GAP_ROWS).map((g) => {
            const n = photosIn(g);
            const q = isQuiet(g);
            const key = `${g.from}/${g.to}`;
            return (
              <li key={g.from} className={q ? "quiet" : undefined}>
                <span>{`${isoToTr(g.from)} – ${isoToTr(g.to)}`}</span>
                <span className="muted">{`${fmtNumber(g.days)} gün`}</span>
                {fill && (
                  <span className="gap-actions">
                    {n >= 2 && (
                      <button className="link" onClick={() => fill.onPhotoTrack(g.from, g.to)} title="Bu dönemde çekilmiş, konumu olan fotoğraflardan yolculuk kaydı oluştur">
                        {`📷 ${fmtNumber(n)} fotoğraftan iz`}
                      </button>
                    )}
                    <button className="link" onClick={fill.onImport} title="Bu dönemi kapsayan konum geçmişi (Google Timeline.json, Records.json) ya da GPX dosyalarını aç">
                      Konum geçmişi…
                    </button>
                    <button
                      className="link"
                      onClick={() => fill.onQuiet(q ? fill.quiet.filter((x) => { const [a, b] = x.split("/"); return !(a <= g.from && g.to <= b); }) : [...fill.quiet, key])}
                      title={q ? "Yeniden eksik say" : "Bu dönemde kayıt olmaması doğal (evdeydim…): listeden çıkar"}
                    >
                      {q ? "Eksik say" : "Bilerek boş"}
                    </button>
                  </span>
                )}
              </li>
            );
          })}
          {gaps.length > GAP_ROWS && <li className="muted">{`… ve ${fmtNumber(gaps.length - GAP_ROWS)} dönem daha`}</li>}
        </ul>
      )}
      {quietCount > 0 && (
        <button className="link muted" onClick={() => setShowQuiet((v) => !v)}>
          {showQuiet ? "Bilerek boş dönemleri gizle" : `${fmtNumber(quietCount)} dönem bilerek boş işaretli · göster`}
        </button>
      )}
    </>
  );
}
