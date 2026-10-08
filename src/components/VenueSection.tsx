import { useMemo, useState } from "react";
import { venuesAt, type Venue } from "../api";
import { fmtDuration, fmtNumber, isoToTr } from "../format";
import { cellOf, venueBook, venueIcon, visitStops } from "../venues";
import type { FileEntry } from "../types";

const CHUNK = 100;
const ROWS = 40;
/** Hücre → mekân (oturum boyunca; karolar zaten diskte önbellekte). */
const known = new Map<string, Venue | null>();

/** Özet'te ziyaret defteri: duraklanan kafeler, lokantalar, müzeler… en çok
 * gidilen önce. Mekân adları OpenStreetMap karolarından istek üzerine okunur. */
export function VenueSection({ files }: { files: FileEntry[] }) {
  const stops = useMemo(() => visitStops(files.map((f) => f.summary)), [files]);
  const [progress, setProgress] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const book = useMemo(() => venueBook(stops, known), [stops, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const missing = useMemo(() => {
    const seen = new Set<string>();
    return stops.filter((s) => !known.has(s.cell) && !seen.has(s.cell) && seen.add(s.cell));
  }, [stops, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!stops.length) return null;

  const run = async () => {
    for (let i = 0; i < missing.length; i += CHUNK) {
      setProgress(`${fmtNumber(i)} / ${fmtNumber(missing.length)}`);
      const part = missing.slice(i, i + CHUNK);
      const list = await venuesAt(part.map((s) => [s.lon, s.lat])).catch(() => null);
      if (!Array.isArray(list)) break;
      part.forEach((s, k) => known.set(cellOf(s.lon, s.lat), list[k] ?? null));
      setVersion((v) => v + 1);
    }
    setProgress(null);
  };

  return (
    <>
      <h3 className="chart-title">Ziyaret defteri</h3>
      <div className="filter-row">
        {missing.length > 0 && (
          <button className="btn small" onClick={run} disabled={progress != null}>
            {progress ? `Mekânlar aranıyor ${progress}` : `☕ ${fmtNumber(missing.length)} durak yerinde mekân ara`}
          </button>
        )}
        <span className="muted small">10 dakikadan uzun duraklar; yanındaki kafe, lokanta, müze… (OpenStreetMap)</span>
      </div>
      {book.length > 0 && (
        <table className="data-table compact" data-testid="venues">
          <thead>
            <tr>
              <th>Mekân</th>
              <th>Gün</th>
              <th>Toplam</th>
              <th>İlk</th>
              <th>Son</th>
            </tr>
          </thead>
          <tbody>
            {book.slice(0, ROWS).map((v) => (
              <tr key={`${v.name}-${v.kind}`}>
                <td data-no-i18n>{`${venueIcon(v.kind)} ${v.name}`}</td>
                <td>{fmtNumber(v.visits)}</td>
                <td>{fmtDuration(v.totalMs)}</td>
                <td>{isoToTr(v.first)}</td>
                <td>{isoToTr(v.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
