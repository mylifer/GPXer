import { useMemo, useState } from "react";
import type { NamedPlace } from "../api";
import { fmtDuration, fmtNumber, isoToTr } from "../format";
import { placeStats } from "../summary";
import type { FileEntry } from "../types";
import { flagOf } from "../visits";

const TOP = 15;

/** Özet'te yer bazlı istatistik: hangi yerde/şehirde kaç gün, kaç kez, ilk ve son. */
export function PlaceStatsSection({ files, places, from, to }: { files: FileEntry[]; places: NamedPlace[]; from: string; to: string }) {
  const st = useMemo(() => placeStats(files, places, from, to), [files, places, from, to]);
  const [all, setAll] = useState(false);
  if (!st.named.length && !st.cities.length) return null;
  const cities = all ? st.cities : st.cities.slice(0, TOP);
  return (
    <>
      <h3 className="chart-title">Yer istatistikleri</h3>
      <div className="table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Yer</th>
              <th>Gün</th>
              <th>Ziyaret</th>
              <th>Süre</th>
              <th>İlk</th>
              <th>Son</th>
            </tr>
          </thead>
          <tbody>
            {st.named.map((p) => (
              <tr key={`n${p.name}`}>
                <td>
                  <strong data-no-i18n>{p.name}</strong>
                </td>
                <td>{fmtNumber(p.days)}</td>
                <td>{fmtNumber(p.visits)}</td>
                <td>{fmtDuration(p.ms)}</td>
                <td>{isoToTr(p.first)}</td>
                <td>{isoToTr(p.last)}</td>
              </tr>
            ))}
            {cities.map((c) => (
              <tr key={`c${c.cc}${c.name}`}>
                <td>
                  {c.cc ? flagOf(c.cc) : ""} {c.name}
                </td>
                <td>{fmtNumber(c.days)}</td>
                <td>{fmtNumber(c.visits)}</td>
                <td>—</td>
                <td>{isoToTr(c.first)}</td>
                <td>{isoToTr(c.last)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small-note">
        Adlandırılmış yerlerde (kalın) duraklamalar, şehirlerde kaydın saat saat geçtiği yerler sayılır; ardışık günler tek
        ziyarettir.
        {st.cities.length > TOP && (
          <>
            {" "}
            <button className="link" onClick={() => setAll((v) => !v)}>
              {all ? "Daha az göster" : `Tüm şehirler (${fmtNumber(st.cities.length)})`}
            </button>
          </>
        )}
      </p>
    </>
  );
}
