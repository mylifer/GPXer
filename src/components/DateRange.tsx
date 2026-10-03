import { useEffect, useMemo, useRef, useState } from "react";
import { MONTHS, isoOf, isoToTr, trToIso } from "../format";

const WEEKDAYS = ["Pt", "Sa", "Ça", "Pe", "Cu", "Ct", "Pz"];

function Calendar({ value, onPick }: { value: string; onPick(iso: string): void }) {
  const init = value ? new Date(`${value}T00:00:00`) : new Date();
  const [y, setY] = useState(init.getFullYear());
  const [m, setM] = useState(init.getMonth());
  const today = isoOf(new Date());

  const cells = useMemo(() => {
    const first = new Date(y, m, 1);
    // Pazartesi ile başlayan hafta.
    const offset = (first.getDay() + 6) % 7;
    const days = new Date(y, m + 1, 0).getDate();
    const out: (string | null)[] = Array(offset).fill(null);
    for (let d = 1; d <= days; d++) out.push(isoOf(new Date(y, m, d)));
    return out;
  }, [y, m]);

  const step = (delta: number) => {
    const d = new Date(y, m + delta, 1);
    setY(d.getFullYear());
    setM(d.getMonth());
  };

  const years = [];
  for (let i = new Date().getFullYear() + 1; i >= 1990; i--) years.push(i);

  return (
    <div className="calendar" onMouseDown={(e) => e.preventDefault()}>
      <div className="cal-head">
        <button type="button" className="icon-btn" onClick={() => step(-1)} aria-label="Önceki ay">
          ‹
        </button>
        <select value={m} onChange={(e) => setM(Number(e.target.value))}>
          {MONTHS.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
        <select value={y} onChange={(e) => setY(Number(e.target.value))}>
          {years.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <button type="button" className="icon-btn" onClick={() => step(1)} aria-label="Sonraki ay">
          ›
        </button>
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((w) => (
          <span key={w} className="cal-wd">
            {w}
          </span>
        ))}
        {cells.map((iso, i) =>
          iso ? (
            <button
              type="button"
              key={iso}
              className={`cal-day${iso === value ? " picked" : ""}${iso === today ? " today" : ""}`}
              onClick={() => onPick(iso)}
            >
              {Number(iso.slice(8))}
            </button>
          ) : (
            <span key={`e${i}`} />
          ),
        )}
      </div>
    </div>
  );
}

/** gg.aa.yyyy biçiminde yazılabilen, takvimle de seçilebilen tarih alanı. */
function DateField({ label, value, onChange }: { label: string; value: string; onChange(iso: string): void }) {
  const [text, setText] = useState(isoToTr(value));
  const [open, setOpen] = useState(false);
  const [bad, setBad] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setText(isoToTr(value));
    setBad(false);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const commit = () => {
    if (text.trim() === "") {
      setBad(false);
      if (value) onChange("");
      return;
    }
    const iso = trToIso(text);
    setBad(!iso);
    if (iso && iso !== value) onChange(iso);
  };

  // Rakam yazılırken noktaları kendiliğinden ekler: 01032025 → 01.03.2025
  const onInput = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    if (/[^\d.]/.test(raw) || raw.includes(".")) {
      setText(raw.slice(0, 10));
      return;
    }
    let out = digits.slice(0, 2);
    if (digits.length > 2) out += "." + digits.slice(2, 4);
    if (digits.length > 4) out += "." + digits.slice(4);
    setText(out);
  };

  return (
    <div className="date-field" ref={wrap}>
      <span>{label}</span>
      <div className={`date-input${bad ? " bad" : ""}`}>
        <input
          type="text"
          aria-label={label}
          inputMode="numeric"
          placeholder="gg.aa.yyyy"
          value={text}
          onChange={(e) => onInput(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") setOpen(false);
          }}
          title={bad ? "Geçersiz tarih: gg.aa.yyyy biçiminde yazın" : undefined}
        />
        {value && (
          <button type="button" className="icon-btn tiny" title="Temizle" onClick={() => onChange("")}>
            ×
          </button>
        )}
        <button type="button" className="icon-btn tiny" title="Takvim" onClick={() => setOpen((v) => !v)}>
          ▾
        </button>
      </div>
      {open && (
        <Calendar
          value={value}
          onPick={(iso) => {
            onChange(iso);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

type Preset =
  | "today"
  | "yesterday"
  | "this-week"
  | "last-week"
  | "this-month"
  | "last-month"
  | "last-7"
  | "last-30"
  | "this-year"
  | "last-year";

export const PRESETS: { id: Preset; label: string }[] = [
  { id: "today", label: "Bugün" },
  { id: "yesterday", label: "Dün" },
  { id: "this-week", label: "Bu hafta" },
  { id: "last-week", label: "Geçen hafta" },
  { id: "last-7", label: "Son 7 gün" },
  { id: "this-month", label: "Bu ay" },
  { id: "last-month", label: "Geçen ay" },
  { id: "last-30", label: "Son 30 gün" },
  { id: "this-year", label: "Bu yıl" },
  { id: "last-year", label: "Geçen yıl" },
];

function presetRange(p: Preset, now = new Date()): [string, string] {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const day = (off: number) => isoOf(new Date(y, m, d + off));
  const monday = d - ((now.getDay() + 6) % 7);
  switch (p) {
    case "today":
      return [day(0), day(0)];
    case "yesterday":
      return [day(-1), day(-1)];
    case "this-week":
      return [isoOf(new Date(y, m, monday)), isoOf(new Date(y, m, monday + 6))];
    case "last-week":
      return [isoOf(new Date(y, m, monday - 7)), isoOf(new Date(y, m, monday - 1))];
    case "last-7":
      return [day(-6), day(0)];
    case "this-month":
      return [isoOf(new Date(y, m, 1)), isoOf(new Date(y, m + 1, 0))];
    case "last-month":
      return [isoOf(new Date(y, m - 1, 1)), isoOf(new Date(y, m, 0))];
    case "last-30":
      return [day(-29), day(0)];
    case "this-year":
      return [`${y}-01-01`, `${y}-12-31`];
    case "last-year":
      return [`${y - 1}-01-01`, `${y - 1}-12-31`];
  }
}

/** Yıl ya da yıl+ay için tarih aralığı. */
export function periodRange(year: number, month: number | null): [string, string] {
  if (month == null) return [`${year}-01-01`, `${year}-12-31`];
  return [isoOf(new Date(year, month, 1)), isoOf(new Date(year, month + 1, 0))];
}

interface RangeProps {
  from: string;
  to: string;
  /** Kayıtların bulunduğu yıllar (yeni → eski). */
  years: number[];
  onChange(from: string, to: string): void;
}

export function DateRange({ from, to, years, onChange }: RangeProps) {
  const [year, setYear] = useState<string>("");
  const [month, setMonth] = useState<string>("");

  // Aralık elle değişince yıl/ay seçimi eşleşmiyorsa temizlenir.
  useEffect(() => {
    if (!year) return;
    const [f, t] = periodRange(Number(year), month === "" ? null : Number(month));
    if (f !== from || t !== to) {
      setYear("");
      setMonth("");
    }
  }, [from, to]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickPeriod = (y: string, mo: string) => {
    setYear(y);
    setMonth(mo);
    if (!y) return onChange("", "");
    const [f, t] = periodRange(Number(y), mo === "" ? null : Number(mo));
    onChange(f, t);
  };

  return (
    <div className="date-range">
      <div className="filter-row">
        <DateField label="Başlangıç" value={from} onChange={(v) => onChange(v, to)} />
        <DateField label="Bitiş" value={to} onChange={(v) => onChange(from, v)} />
      </div>
      <select
          className="preset-select"
          value=""
          onChange={(e) => {
            const p = e.target.value as Preset;
            if (p) onChange(...presetRange(p));
          }}
          title="Hazır aralıklar"
        >
          <option value="">Hızlı seçim…</option>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      <div className="filter-row">
        <select value={year} onChange={(e) => pickPeriod(e.target.value, "")} title="Yıl">
          <option value="">Yıl</option>
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <select value={month} disabled={!year} onChange={(e) => pickPeriod(year, e.target.value)} title="Ay">
          <option value="">Tüm yıl</option>
          {MONTHS.map((n, i) => (
            <option key={n} value={i}>
              {n}
            </option>
          ))}
        </select>
        {(from || to) && (
          <button type="button" className="btn small ghost-inline" onClick={() => onChange("", "")}>
            Sıfırla
          </button>
        )}
      </div>
    </div>
  );
}
