import { useState } from "react";
import type { FileSummary } from "../api";
import { fmtDuration, fmtTimestamp, isoOf, isoToTr, parseTrWall, tzOf } from "../format";
import { Modal } from "./Modal";

export type GoToResult =
  | { kind: "cover"; path: string; t: number }
  /** dt < 0: en yakın kayıt sorulan andan sonra başlıyor. `go`: 6 saatten yakın. */
  | { kind: "near"; path: string; t: number; dt: number; go: boolean }
  | { kind: "none" };

const pad = (n: number) => String(n).padStart(2, "0");

/** "Ne zaman neredeydim?": tarih ve saat sorulur, o anı kapsayan kayda gidilir. */
export function GoToDialog({
  find,
  summaryOf,
  onGo,
  onClose,
}: {
  find(wall: number): GoToResult;
  summaryOf(path: string): FileSummary | undefined;
  onGo(r: GoToResult): void;
  onClose(): void;
}) {
  const now = new Date();
  const [date, setDate] = useState(() => isoToTr(isoOf(now)));
  const [time, setTime] = useState(() => `${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const [miss, setMiss] = useState<GoToResult | null>(null);
  const wall = parseTrWall(date, time);

  const submit = () => {
    if (wall == null) return;
    const r = find(wall);
    if (r.kind === "cover" || (r.kind === "near" && r.go)) onGo(r);
    else setMiss(r);
  };

  const missSummary = miss?.kind === "near" ? summaryOf(miss.path) : undefined;

  return (
    <Modal title="Ne zaman neredeydim?" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="goto-row">
          <label className="field">
            <span>Tarih (gg.aa.yyyy)</span>
            <input
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setMiss(null);
              }}
              placeholder="gg.aa.yyyy"
              inputMode="numeric"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Saat (ss:dd)</span>
            <input
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                setMiss(null);
              }}
              placeholder="ss:dd"
              inputMode="numeric"
            />
          </label>
        </div>
        <small>
          O anı kapsayan kayıt seçilir, imleç o ana en yakın noktaya konur ve harita oraya kayar. Kayıt yoksa 6 saat
          içindeki en yakın kayda gidilir. Saat, Ayarlar'daki saat dilimi kipine göre okunur.
        </small>
        {miss?.kind === "none" && <div className="hint">Tarihli kayıt yok.</div>}
        {miss?.kind === "near" && missSummary && (
          <div className="hint goto-miss">
            <span>
              Kayıt yok (en yakın: <strong>{missSummary.name || missSummary.fileName}</strong>,{" "}
              {fmtDuration(Math.abs(miss.dt))} {miss.dt < 0 ? "sonra" : "önce"} · {fmtTimestamp(miss.t, tzOf(missSummary))})
            </span>
            <button type="button" className="btn small" onClick={() => onGo(miss)}>
              Oraya git
            </button>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" className="btn primary" disabled={wall == null}>
            Git
          </button>
        </div>
      </form>
    </Modal>
  );
}
