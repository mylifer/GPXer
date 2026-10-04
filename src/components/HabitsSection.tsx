import { useMemo } from "react";
import { t } from "../i18n";
import { drivingHabits } from "../habits";
import { fmtDate, fmtDistance, fmtDuration, fmtNumber, tzOf } from "../format";
import type { FileEntry } from "../types";

const DAYS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"].map(t);

function Bars({ values, labels, title, tip }: { values: number[]; labels: string[]; title: string; tip(i: number): string }) {
  const max = Math.max(1, ...values);
  const w = 100 / values.length;
  return (
    <figure className="habit-chart">
      <figcaption>{title}</figcaption>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={title}>
        {values.map((v, i) => (
          <rect key={i} x={i * w + w * 0.12} width={w * 0.76} y={40 - (v / max) * 38} height={(v / max) * 38} className="habit-bar">
            <title>{tip(i)}</title>
          </rect>
        ))}
      </svg>
      <div className="habit-labels" style={{ gridTemplateColumns: `repeat(${values.length}, 1fr)` }}>
        {labels.map((l, i) => (
          <span key={i}>{l}</span>
        ))}
      </div>
    </figure>
  );
}

/** Özet'te sürüş alışkanlıkları (araç kayıtları; yoksa tümü). */
export function HabitsSection({ files, from, to, onOpen }: { files: FileEntry[]; from: string; to: string; onOpen(path: string): void }) {
  const cars = files.filter((f) => f.summary.activity === "car");
  const list = cars.length ? cars : files;
  const h = useMemo(
    () =>
      drivingHabits(
        list.map((f) => f.summary),
        from,
        to,
      ),
    [list, from, to],
  );
  if (h.totalM <= 0) return null;
  const rec = h.longest ? files.find((f) => f.summary.path === h.longest!.path) : undefined;
  return (
    <>
      <h3 className="chart-title">{cars.length ? "Sürüş alışkanlıkları (araç kayıtları)" : "Hareket alışkanlıkları"}</h3>
      <p className="small-note">
        Gece (20:00–06:00) gidilen yol: <strong>%{fmtNumber(Math.round(h.nightShare * 100))}</strong>
        {h.longest && rec && (
          <>
            {" "}
            · en uzun molasız ({">"}15 dk mola vermeden):{" "}
            <button className="link" onClick={() => onOpen(rec.summary.path)}>
              <strong>{fmtDuration(h.longest.ms)}</strong> · {fmtDate(h.longest.start, tzOf(rec.summary))} · <span data-no-i18n>{rec.summary.name || rec.summary.fileName}</span>
            </button>
          </>
        )}
      </p>
      <div className="habit-charts">
        <Bars
          title="Günün saatlerine göre yol (kaydın yapıldığı yerin saati)"
          values={h.byHour}
          labels={h.byHour.map((_, i) => (i % 3 === 0 ? String(i).padStart(2, "0") : ""))}
          tip={(i) =>
            `${String(i).padStart(2, "0")}:00–${String((i + 1) % 24).padStart(2, "0")}:00 · ${fmtDistance(h.byHour[i])}${
              h.speedByHour[i] != null ? ` · ort. ${fmtNumber(Math.round(h.speedByHour[i]!))} km/sa` : ""
            }`
          }
        />
        <Bars title="Haftanın günlerine göre yol" values={h.byWeekday} labels={DAYS} tip={(i) => `${DAYS[i]} · ${fmtDistance(h.byWeekday[i])}`} />
      </div>
    </>
  );
}
