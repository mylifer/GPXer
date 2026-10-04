import { useMemo } from "react";
import { dedupedTotals } from "../days";
import { fmtDistance, fmtNumber } from "../format";
import type { Goals } from "../prefs";
import type { FileEntry } from "../types";

/** Özet'te yıllık hedeflere göre ilerleme (bu yıl, ya da filtre tek bir yılsa o yıl). */
export function GoalsSection({ files, goals, from, to }: { files: FileEntry[]; goals: Goals; from: string; to: string }) {
  const now = new Date();
  const year = from && to && from.slice(0, 4) === to.slice(0, 4) ? from.slice(0, 4) : String(now.getFullYear());
  const t = useMemo(
    () =>
      dedupedTotals(
        files.map((f) => f.summary),
        `${year}-01-01`,
        `${year}-12-31`,
      ),
    [files, year],
  );
  if (!goals.km && !goals.days) return null;
  // Yılın geçen kısmı: geçmiş yıllarda tamamı, gelecekte hiç.
  const y = Number(year);
  const start = new Date(y, 0, 1).getTime();
  const end = new Date(y + 1, 0, 1).getTime();
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
  const rows: { label: string; done: number; goal: number; fmt(v: number): string }[] = [];
  if (goals.km) rows.push({ label: "Mesafe", done: t.distanceM / 1000, goal: goals.km, fmt: (v) => fmtDistance(v * 1000) });
  if (goals.days) rows.push({ label: "Yolda geçen gün", done: t.days, goal: goals.days, fmt: (v) => `${fmtNumber(Math.round(v))} gün` });
  return (
    <div className="goals">
      <h3 className="chart-title">{year} hedefleri</h3>
      {rows.map((r) => {
        const share = r.done / r.goal;
        const ahead = share - elapsed;
        return (
          <div key={r.label} className="goal">
            <div className="goal-head">
              <span>{r.label}</span>
              <strong>
                {r.fmt(r.done)} / {r.fmt(r.goal)} · %{fmtNumber(Math.round(share * 100))}
              </strong>
            </div>
            <div className="goal-bar">
              <div className="goal-fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
              {elapsed > 0 && elapsed < 1 && <div className="goal-mark" style={{ left: `${elapsed * 100}%` }} title="Takvime göre bugün olması gereken yer" />}
            </div>
            <small className="muted">
              {share >= 1
                ? "Hedefe ulaşıldı 🎉"
                : elapsed >= 1
                  ? `Hedefin ${r.fmt(r.goal - r.done)} gerisinde kalındı`
                  : ahead >= 0
                    ? `Takvimin ${r.fmt(ahead * r.goal)} önündesiniz`
                    : `Takvimin ${r.fmt(-ahead * r.goal)} gerisindesiniz`}
            </small>
          </div>
        );
      })}
    </div>
  );
}
