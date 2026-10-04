import { useEffect, useMemo, useState } from "react";
import { dayBuckets } from "../days";
import { CARD_H, CARD_W, drawYearCard, yearCardData } from "../shareCard";
import type { FileEntry } from "../types";

interface Props {
  files: FileEntry[];
  /** Kenar çubuğundaki tarih filtresinin başı: kart önce o yılı gösterir. */
  from: string;
  onSave(name: string, base64: string): void;
}

/** Yılın özetini paylaşılabilir bir görüntü (PNG) olarak verir. */
export function YearCardSection({ files, from, onSave }: Props) {
  const years = useMemo(() => {
    const set = new Set<string>();
    for (const f of files) for (const d of dayBuckets(f.summary)) set.add(d.day.slice(0, 4));
    return [...set].sort().reverse();
  }, [files]);
  const [year, setYear] = useState(() => (from && years.includes(from.slice(0, 4)) ? from.slice(0, 4) : years[0] ?? ""));
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const shown = years.includes(year) ? year : (years[0] ?? "");

  useEffect(() => {
    if (!open || !shown) return;
    const canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawYearCard(ctx, yearCardData(files, shown));
    setUrl(canvas.toDataURL("image/png"));
  }, [open, shown, files]);

  if (!years.length) return null;
  return (
    <>
      <h3 className="chart-title">Yıl kartı</h3>
      <div className="filter-row">
        <select value={shown} onChange={(e) => setYear(e.target.value)} aria-label="Yıl">
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        {!open ? (
          <button className="btn small" onClick={() => setOpen(true)}>
            🖼 Kartı oluştur
          </button>
        ) : (
          <button
            className="btn small primary"
            disabled={!url}
            onClick={() => url && onSave(`gpxer-${shown}.png`, url.split(",")[1])}
          >
            PNG olarak kaydet…
          </button>
        )}
        <span className="muted small">Toplamlar, ülkeler, en uzun yolculuk ve yılın izleri; paylaşmak için.</span>
      </div>
      {open && url && <img className="year-card" src={url} alt={`${shown} yıl kartı`} />}
    </>
  );
}
