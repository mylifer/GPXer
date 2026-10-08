import { useMemo } from "react";
import type { FileMeta } from "../api";
import { fmtDistance, fmtNumber, isoToTr } from "../format";
import { peopleStats } from "../people";
import type { FileEntry } from "../types";

/** Özet'te kimlerle ne kadar yol gidildiği; ada tıklanınca liste o kişiye süzülür. */
export function PeopleSection({ files, meta, onPerson }: { files: FileEntry[]; meta: Record<string, FileMeta>; onPerson(name: string): void }) {
  const rows = useMemo(() => peopleStats(files, meta), [files, meta]);
  if (!rows.length) return null;
  return (
    <>
      <h3 className="chart-title">Kimlerle</h3>
      <table className="data-table compact" data-testid="people">
        <thead>
          <tr>
            <th>Kişi</th>
            <th>Gün</th>
            <th>Kayıt</th>
            <th>Mesafe</th>
            <th>İlk</th>
            <th>Son</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.name}>
              <td>
                <button className="link" onClick={() => onPerson(p.name)} title="Listeyi bu kişinin olduğu kayıtlara süz" data-no-i18n>
                  {`👤 ${p.name}`}
                </button>
              </td>
              <td>{fmtNumber(p.days)}</td>
              <td>{fmtNumber(p.records)}</td>
              <td>{fmtDistance(p.distanceM)}</td>
              <td>{isoToTr(p.first)}</td>
              <td>{isoToTr(p.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
