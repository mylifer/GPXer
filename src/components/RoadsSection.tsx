import { useEffect, useRef, useState } from "react";
import { prepareRoads, roadStats, type RoadStats } from "../api";
import { fmtDistance, fmtNumber } from "../format";
import type { FileEntry } from "../types";

const TOP = 12;
const CHUNK = 5;

/** Özet'te en çok geçilen yollar ve ilçe ilçe geçilen mahalleler (kayıtların
 * güzergâh dökümlerinden; eksik dökümler istek üzerine çıkarılır). */
export function RoadsSection({ files }: { files: FileEntry[] }) {
  const [st, setSt] = useState<RoadStats | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [all, setAll] = useState(false);
  const stop = useRef(false);
  const paths = files.map((f) => f.summary.path);
  const key = paths.join("\n");

  useEffect(() => {
    let live = true;
    roadStats(paths)
      .then((r) => live && setSt(r))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const prepare = async () => {
    stop.current = false;
    // Hazır olmayanlar: istatistik hepsini saymadığı için tümü gönderilir; hazır olanlar arka uçta atlanır.
    setProgress({ done: 0, total: paths.length });
    for (let i = 0; i < paths.length && !stop.current; i += CHUNK) {
      await prepareRoads(paths.slice(i, i + CHUNK)).catch(() => 0);
      setProgress({ done: Math.min(paths.length, i + CHUNK), total: paths.length });
      if ((i / CHUNK) % 10 === 9) setSt(await roadStats(paths).catch(() => null));
    }
    setSt(await roadStats(paths).catch(() => null));
    setProgress(null);
  };

  if (!st || !paths.length) return null;
  const missing = paths.length - st.ready;
  const roads = all ? st.roads : st.roads.slice(0, TOP);
  return (
    <>
      <h3 className="chart-title">Yollar ve mahalleler</h3>
      {missing > 0 && (
        <div className="hint roads-hint">
          {progress ? (
            <>
              <progress max={progress.total} value={progress.done} /> {fmtNumber(progress.done)} / {fmtNumber(progress.total)}{" "}
              <button className="btn small" onClick={() => (stop.current = true)}>
                Durdur
              </button>
            </>
          ) : (
            <>
              {`${fmtNumber(st.ready)} / ${fmtNumber(paths.length)} kaydın güzergâhı hazır.`}{" "}
              <button
                className="btn small"
                onClick={prepare}
                title="Kayıtların geçtiği yollar haritadan çıkarılır (gezilmemiş bölgelerde internet gerekir; bir kez yapılır)"
              >
                Eksikleri çıkar
              </button>
            </>
          )}
        </div>
      )}
      {st.roads.length > 0 && (
        <div className="table-wrap">
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Yol</th>
                <th>İlçe</th>
                <th>Mesafe</th>
                <th>Kayıt</th>
              </tr>
            </thead>
            <tbody>
              {roads.map(([name, big, d, n]) => (
                <tr key={`${name}|${big}`}>
                  <td data-no-i18n>
                    <strong>{name}</strong>
                  </td>
                  <td data-no-i18n>{big ?? ""}</td>
                  <td>{fmtDistance(d)}</td>
                  <td>{fmtNumber(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {st.roads.length > TOP && (
            <button className="link-btn" onClick={() => setAll((a) => !a)}>
              {all ? "Daha az göster" : `Tümü (${st.roads.length})`}
            </button>
          )}
        </div>
      )}
      {st.hoods.length > 0 && (
        <div className="hoods">
          {st.hoods.map(([big, list]) => (
            <div key={big} className="hood-row">
              <strong data-no-i18n>{big}</strong> <span className="muted">{`${fmtNumber(list.length)} mahalle/semt`}</span>
              <div className="visited-countries" data-no-i18n>
                {list.map(([h, n]) => (
                  <span key={h} className="chip" title={`${h}: ${n} kayıt`}>
                    {h}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {st.ready > 0 && !st.roads.length && <div className="muted small-note">Hazır güzergâhlarda adlı yol bulunamadı.</div>}
    </>
  );
}
