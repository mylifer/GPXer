import { useMemo, useState } from "react";
import type { FileSummary, NamedPlace } from "../api";
import { fmtDate, fmtDistance, fmtDuration, fmtLatLon, fmtNumber, fmtTime, tzOf } from "../format";
import { namedPlaceAt } from "../places";
import { legsBetween } from "../routeSearch";
import { Modal } from "./Modal";

const RADII = [500, 1000, 3000, 10000];

/** İki yer arasındaki yolculuklar (haritada sağ tıklayıp A ve B seçilir). */
export function RouteSearchDialog({
  files,
  a,
  b,
  places,
  onSwap,
  onOpen,
  onClose,
}: {
  files: FileSummary[];
  a: [number, number];
  b: [number, number];
  places: NamedPlace[];
  onSwap(): void;
  onOpen(path: string, leave: number, arrive: number): void;
  onClose(): void;
}) {
  const [radius, setRadius] = useState(3000);
  const legs = useMemo(() => legsBetween(files, a, b, radius), [files, a, b, radius]);
  const byPath = useMemo(() => new Map(files.map((s) => [s.path, s])), [files]);
  const durs = legs.map((l) => l.arrive - l.leave);
  const best = durs.length ? Math.min(...durs) : null;
  const avg = durs.length ? durs.reduce((x, y) => x + y, 0) / durs.length : null;
  const label = (p: [number, number]) => namedPlaceAt(p[0], p[1], places)?.name ?? fmtLatLon(p[1], p[0]);
  return (
    <Modal title="Güzergâh arama" onClose={onClose} wide>
      <div className="filter-row">
        <span>
          <strong>A</strong> {label(a)} → <strong>B</strong> {label(b)}
        </span>
        <button className="btn small" onClick={onSwap} title="Ters yöndeki yolculukları ara">
          ⇄ Yönü çevir
        </button>
        <label className="inline-select">
          Yakınlık{" "}
          <select value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
            {RADII.map((r) => (
              <option key={r} value={r}>
                {fmtDistance(r)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {legs.length === 0 ? (
        <p className="muted small-note">
          A'nın yakınından geçip sonra B'ye varan yolculuk yok. Yakınlığı artırmayı ya da yönü çevirmeyi deneyin.
        </p>
      ) : (
        <>
          <p className="muted small-note">
            {fmtNumber(legs.length)} yolculuk · en hızlısı {fmtDuration(best)} · ortalama {fmtDuration(avg)}
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Çıkış → varış</th>
                <th>Süre</th>
                <th>Mesafe</th>
                <th>Kayıt</th>
              </tr>
            </thead>
            <tbody>
              {legs.map((l) => {
                const s = byPath.get(l.path);
                const tz = tzOf(s);
                const d = l.arrive - l.leave;
                return (
                  <tr key={`${l.path}${l.leave}`} className="clickable" onClick={() => onOpen(l.path, l.leave, l.arrive)}>
                    <td>{fmtDate(l.leave, tz)}</td>
                    <td>
                      {fmtTime(l.leave, tz).slice(0, 5)} → {fmtTime(l.arrive, tz).slice(0, 5)}
                    </td>
                    <td>
                      {fmtDuration(d)}
                      {d === best && legs.length > 1 && <span className="badge">en hızlı</span>}
                    </td>
                    <td>{fmtDistance(l.distanceM)}</td>
                    <td data-no-i18n>{s?.name || s?.fileName}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </Modal>
  );
}
