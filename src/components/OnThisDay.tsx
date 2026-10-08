import { useMemo, useState } from "react";
import { fmtNumber, isoOf, isoToTr } from "../format";
import { memoryText, onThisDay, type Memory } from "../onThisDay";
import type { FileEntry } from "../types";

const KEY = "gpxer.onThisDay";

const readDismissed = () => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};

/** Haritanın üstünde günde bir kez: "1 yıl önce bugün…" (kapatılınca o gün bir daha çıkmaz). */
export function OnThisDayCard({ files, notes = {}, onShow }: { files: FileEntry[]; notes?: Record<string, string>; onShow(paths: string[]): void }) {
  const today = isoOf(new Date());
  const [dismissed, setDismissed] = useState(readDismissed);
  const memories = useMemo(() => (dismissed === today ? [] : onThisDay(files, today)), [files, today, dismissed]);
  if (!memories.length) return null;
  const m = memories[0];
  const close = () => {
    try {
      localStorage.setItem(KEY, today);
    } catch {
      // tarayıcı deposu yoksa yalnızca bu oturumda kapanır
    }
    setDismissed(today);
  };
  return (
    <div className="otd-card" role="status">
      <span className="otd-icon" aria-hidden>
        📅
      </span>
      <span>
        <strong>{`${fmtNumber(m.years)} yıl önce bugün`}</strong> <span data-no-i18n>{memoryText(m)}</span>
        {notes[m.day] && (
          <span className="otd-note" data-no-i18n>
            {" "}
            📝 {notes[m.day]}
          </span>
        )}
        {memories.length > 1 && <span className="muted">{` · ${fmtNumber(memories.length - 1)} yıl daha (Özet)`}</span>}
      </span>
      <button className="btn small" onClick={() => onShow(m.entries.map((e) => e.summary.path))}>
        Göster
      </button>
      <button className="icon-btn" onClick={close} aria-label="Kapat" title="Bugün bir daha gösterme">
        ×
      </button>
    </div>
  );
}

/** Özet'te bütün yıllar. */
export function OnThisDaySection({ files, notes = {}, onOpen }: { files: FileEntry[]; notes?: Record<string, string>; onOpen(path: string): void }) {
  const today = isoOf(new Date());
  const memories: Memory[] = useMemo(() => onThisDay(files, today), [files, today]);
  if (!memories.length) return null;
  return (
    <>
      <h3 className="chart-title">Geçmiş yıllarda bugün</h3>
      <ul className="otd-list">
        {memories.map((m) => (
          <li key={m.day}>
            <span className="muted">{`${fmtNumber(m.years)} yıl önce · ${isoToTr(m.day)}`}</span>{" "}
            {m.entries.map((e) => (
              <button key={e.summary.path} className="link-btn" onClick={() => onOpen(e.summary.path)} data-no-i18n>
                {e.summary.name || e.summary.fileName}
              </button>
            ))}
            <span className="muted" data-no-i18n>
              {" "}
              · {memoryText(m)}
            </span>
            {notes[m.day] && (
              <div className="otd-note" data-no-i18n>
                📝 {notes[m.day]}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
