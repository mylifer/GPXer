import { useMemo, useState } from "react";
import type { FileSummary, NamedPlace } from "../api";
import { dayTimeline } from "../dayTimeline";
import { fmtDistance, fmtDuration, fmtTime, isoOf, isoToTr, trToIso, tzOf } from "../format";
import { Modal } from "./Modal";

const shift = (iso: string, days: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return isoOf(new Date(y, m - 1, d + days));
};

/** Bir günün akışı: nerede durulmuş, nereden nereye gidilmiş. */
export function DayDialog({
  files,
  places,
  initialDay,
  daysWithData,
  onFocus,
  onShowDay,
  onOpen,
  onClose,
}: {
  files: FileSummary[];
  places: NamedPlace[];
  initialDay: string;
  /** Kaydı olan günler (önceki / sonraki kayıtlı güne atlamak için), sıralı. */
  daysWithData: string[];
  onFocus(lonLat: [number, number]): void;
  onShowDay(day: string): void;
  onOpen(path: string): void;
  onClose(): void;
}) {
  const [day, setDay] = useState(initialDay);
  const [text, setText] = useState(isoToTr(initialDay));
  const go = (d: string) => {
    setDay(d);
    setText(isoToTr(d));
  };
  const items = useMemo(() => dayTimeline(files, day, places), [files, day, places]);
  const tz = tzOf(files[0]);
  const prevData = [...daysWithData].reverse().find((d) => d < day);
  const nextData = daysWithData.find((d) => d > day);
  const total = items.reduce((a, x) => a + (x.kind === "move" ? x.distanceM : 0), 0);
  const weekday = new Date(`${day}T12:00:00`).toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <Modal title="Gün akışı" onClose={onClose}>
      <div className="filter-row day-nav">
        <button className="btn small" onClick={() => prevData && go(prevData)} disabled={!prevData} title="Kaydı olan önceki gün">
          ⇤
        </button>
        <button className="btn small" onClick={() => go(shift(day, -1))} title="Önceki gün">
          ‹
        </button>
        <input
          className="date-input"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const iso = trToIso(e.target.value);
            if (iso) setDay(iso);
          }}
          placeholder="gg.aa.yyyy"
          aria-label="Gün"
        />
        <button className="btn small" onClick={() => go(shift(day, 1))} title="Sonraki gün">
          ›
        </button>
        <button className="btn small" onClick={() => nextData && go(nextData)} disabled={!nextData} title="Kaydı olan sonraki gün">
          ⇥
        </button>
        <button className="btn small" onClick={() => onShowDay(day)} disabled={!items.length} title="Listeyi ve haritayı bu güne süz">
          Haritada göster
        </button>
      </div>
      <p className="muted small-note">
        {weekday}
        {items.length > 0 && ` · toplam ${fmtDistance(total)} yol`}
      </p>
      {items.length === 0 ? (
        <div className="muted small-note">Bu gün kayıt yok.</div>
      ) : (
        <ol className="day-timeline">
          {items.map((x) => (
            <li key={`${x.kind}${x.start}`} className={`day-${x.kind}`}>
              <span className="day-time">
                {fmtTime(x.start, tz).slice(0, 5)}–{fmtTime(x.end, tz).slice(0, 5)}
              </span>
              {x.kind === "stop" && (
                <button className="link" onClick={() => onFocus([x.lon, x.lat])} title="Haritada göster">
                  {x.night ? "🛏" : "📍"} <strong>{x.place || "Duraklama"}</strong>{" "}
                  <span className="muted">{fmtDuration(x.end - x.start)}</span>
                </button>
              )}
              {x.kind === "move" && (
                <button className="link" onClick={() => onOpen(x.path)} title="Kaydı aç">
                  🚗 {x.from || x.to ? `${x.from || "?"} → ${x.to || "?"}` : "Yolculuk"}{" "}
                  <span className="muted">
                    {fmtDistance(x.distanceM)} · {fmtDuration(x.end - x.start)}
                  </span>
                </button>
              )}
              {x.kind === "none" && <span className="muted">Kayıt yok</span>}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
