import { useMemo, useState } from "react";
import type { FileMeta } from "../api";
import { dayBuckets } from "../days";
import { fmtNumber, isoToTr, monthLabel } from "../format";
import { fmtMoney, type FuelPrefs } from "../fuel";
import { mileageCsv, mileageLog } from "../mileage";
import type { FileEntry } from "../types";
import { Modal } from "./Modal";

/** Kilometre defteri: bir etiketin (ör. "iş") yıllık yolculukları, aylık
 * kilometre ve yakıt tutarı; CSV olarak kaydedilir. */
export function MileageDialog({
  files,
  meta,
  allTags,
  fuel,
  onSave,
  onOpen,
  onClose,
}: {
  files: FileEntry[];
  meta: Record<string, FileMeta>;
  allTags: string[];
  fuel: FuelPrefs;
  onSave(name: string, csv: string): void;
  onOpen(path: string): void;
  onClose(): void;
}) {
  const [tag, setTag] = useState(() => allTags.find((t) => /^i[şs]$/i.test(t)) ?? allTags[0] ?? "");
  const years = useMemo(() => {
    const ys = new Set<string>();
    // Defterle aynı gün mantığı (kaydın ilk günü, saat dilimi ayarına göre).
    for (const f of files) {
      const d = dayBuckets(f.summary)[0]?.day;
      if (d) ys.add(d.slice(0, 4));
    }
    return [...ys].sort().reverse();
  }, [files]);
  const [year, setYear] = useState(() => years[0] ?? String(new Date().getFullYear()));
  const log = useMemo(() => mileageLog(files, meta, tag, year, fuel), [files, meta, tag, year, fuel]);
  return (
    <Modal title="Kilometre defteri" onClose={onClose} wide>
      <div className="filter-row">
        <label className="inline-field">
          <span>Etiket</span>
          <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Etiket" disabled={!allTags.length}>
            {allTags.map((t) => (
              <option key={t} value={t} data-no-i18n>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="inline-field">
          <span>Yıl</span>
          <select value={year} onChange={(e) => setYear(e.target.value)} aria-label="Yıl">
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <button className="btn small" disabled={!log.trips.length} onClick={() => onSave(`kilometre-defteri-${tag}-${year}.csv`, mileageCsv(log))}>
          CSV olarak kaydet…
        </button>
      </div>
      {!allTags.length ? (
        <p className="muted">Önce yolculukları etiketleyin (ör. “iş”); defter etikete göre tutulur.</p>
      ) : !log.trips.length ? (
        <p className="muted">Bu yıl bu etikette kayıt yok.</p>
      ) : (
        <>
          <p data-testid="mileage-total">{`${fmtNumber(log.trips.length)} yolculuk · ${fmtNumber(Math.round(log.km))} km · ${fmtMoney(log.cost)}`}</p>
          <table className="data-table compact" data-testid="mileage-months">
            <thead>
              <tr>
                <th>Ay</th>
                <th>Yolculuk</th>
                <th>Km</th>
                <th>Yakıt</th>
              </tr>
            </thead>
            <tbody>
              {log.months.map((m) => (
                <tr key={m.month}>
                  <td>{monthLabel(m.month)}</td>
                  <td>{fmtNumber(m.trips)}</td>
                  <td>{fmtNumber(Math.round(m.km))}</td>
                  <td>{fmtMoney(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Kayıt</th>
                <th>Güzergâh</th>
                <th>Km</th>
              </tr>
            </thead>
            <tbody>
              {log.trips.map((t) => (
                <tr key={t.path}>
                  <td>{isoToTr(t.day)}</td>
                  <td>
                    <button className="link" onClick={() => onOpen(t.path)} data-no-i18n>
                      {t.name}
                    </button>
                  </td>
                  <td data-no-i18n>{t.route}</td>
                  <td>{fmtNumber(Math.round(t.km))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">Yakıt tutarı Ayarlar'daki tüketim ve fiyatla hesaplanır.</small>
        </>
      )}
    </Modal>
  );
}
