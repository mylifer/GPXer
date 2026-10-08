import { useEffect, useMemo, useState } from "react";
import { streetAt } from "../api";
import { fmtLatLon, fmtNumber, fmtTimestamp, isoToTr, tzOf } from "../format";
import { passesNear } from "../here";
import { t } from "../i18n";
import type { FileEntry } from "../types";
import { Modal } from "./Modal";

const RADII = [50, 150, 500, 2000, 5000];
const SHOW = 300;

/** "Burada ne zaman bulundum?": bir noktanın yakınından geçilen bütün anlar. */
export function HereDialog({
  at,
  pxM,
  files,
  onGo,
  onClose,
}: {
  at: [number, number];
  /** Haritanın bir pikseli kaç metre: başlangıç yarıçapı tıklama hassasiyetinden küçük olmasın. */
  pxM: number;
  files: FileEntry[];
  onGo(path: string): void;
  onClose(): void;
}) {
  const [radius, setRadius] = useState(() => RADII.find((r) => r >= Math.max(150, pxM * 8)) ?? RADII[RADII.length - 1]);
  const [where, setWhere] = useState<string | null>(null);
  useEffect(() => {
    streetAt(at[0], at[1])
      .then((r) => setWhere([r.street, r.area].filter(Boolean).join(" · ") || null))
      .catch(() => {});
  }, [at]);
  const byPath = useMemo(() => new Map(files.map((f) => [f.summary.path, f])), [files]);
  const passes = useMemo(
    () =>
      passesNear(
        files.map((f) => f.summary),
        at[0],
        at[1],
        radius,
      ),
    [files, at, radius],
  );
  const records = new Set(passes.map((p) => p.path)).size;
  const dated = passes.filter((p) => p.t != null);
  const years = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of dated) {
      const y = new Date(p.t!).getFullYear().toString();
      m.set(y, (m.get(y) ?? 0) + 1);
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [dated]);
  const maxY = Math.max(1, ...years.map((y) => y[1]));
  const first = dated[dated.length - 1];
  const last = dated[0];
  const day = (t: number) => isoToTr(new Date(t).toISOString().slice(0, 10));

  return (
    <Modal title="Burada ne zaman bulundum?" onClose={onClose} wide>
      <div className="form here">
        <div className="here-head">
          <strong data-no-i18n>{where ?? fmtLatLon(at[1], at[0])}</strong>
          <label className="inline-field">
            <span>Yarıçap</span>
            <select value={radius} onChange={(e) => setRadius(Number(e.target.value))} aria-label="Yarıçap">
              {RADII.map((r) => (
                <option key={r} value={r}>
                  {r >= 1000 ? `${r / 1000} km` : `${r} m`}
                </option>
              ))}
            </select>
          </label>
        </div>
        {passes.length === 0 ? (
          <div className="muted">Bu noktanın yakınından geçen kayıt yok.</div>
        ) : (
          <>
            <div className="hint" data-testid="here-summary">
              {`${fmtNumber(passes.length)} geçiş · ${fmtNumber(records)} kayıt`}
              {first && last && ` · ${t("ilk")} ${day(first.t!)} · ${t("son")} ${day(last.t!)}`}
            </div>
            {years.length > 1 && (
              <div className="here-years" aria-label="Yıllara göre">
                {years.map(([y, n]) => (
                  <div key={y} className="here-year" title={`${y}: ${n}`}>
                    <div className="bar" style={{ height: `${Math.max(4, (n / maxY) * 48)}px` }} />
                    <span>{y.slice(2)}</span>
                  </div>
                ))}
              </div>
            )}
            <ul className="here-list">
              {passes.slice(0, SHOW).map((p, i) => {
                const f = byPath.get(p.path);
                const s = f?.summary;
                return (
                  <li key={`${p.path}${i}`}>
                    <button className="link" onClick={() => onGo(p.path)}>
                      <span className="stop-time">{p.t != null ? fmtTimestamp(p.t, s ? tzOf(s) : undefined) : "tarihsiz"}</span>
                      <span className="here-name" data-no-i18n>
                        {s ? s.name || s.fileName : p.path}
                      </span>
                      <span className="muted">{`${fmtNumber(Math.round(p.distM))} m`}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {passes.length > SHOW && <small>{`İlk ${SHOW} geçiş gösteriliyor.`}</small>}
          </>
        )}
      </div>
    </Modal>
  );
}
