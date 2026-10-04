import { useEffect, useMemo, useRef, useState } from "react";
import { searchKey } from "../format";

export interface Command {
  id: string;
  label: string;
  /** Sağda gösterilen ek bilgi (kısayol, tarih…). */
  hint?: string;
  /** Aramada eşleşecek ek sözcükler. */
  keywords?: string;
  group: string;
  run(): void;
}

const LIMIT = 60;

/** Ctrl/⌘+K: tüm işlemler ve kayıtlar tek arama kutusundan. */
export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose(): void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    const words = searchKey(q).split(/\s+/).filter(Boolean);
    if (!words.length) return commands.filter((c) => c.group !== "Kayıt").slice(0, LIMIT);
    const scored = commands.flatMap((c) => {
      const hay = searchKey(`${c.label} ${c.keywords ?? ""} ${c.hint ?? ""}`);
      if (!words.every((w) => hay.includes(w))) return [];
      const label = searchKey(c.label);
      // Başta eşleşenler ve işlemler önce.
      const score = (label.startsWith(words[0]) ? 0 : 1) + (c.group === "Kayıt" ? 2 : 0);
      return [{ c, score }];
    });
    return scored
      .sort((a, b) => a.score - b.score)
      .slice(0, LIMIT)
      .map((x) => x.c);
  }, [q, commands]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".active")?.scrollIntoView({ block: "nearest" });
  }, [sel]);
  const run = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label="Komut paleti" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={q}
          placeholder="Ne yapmak istersiniz? İşlem, kayıt, yer adı yazın…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(shown.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(shown[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          aria-label="Komut ara"
        />
        <ul ref={list}>
          {shown.map((c, i) => (
            <li key={c.id} className={i === sel ? "active" : ""} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span className="palette-group">{c.group}</span>
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </li>
          ))}
          {shown.length === 0 && <li className="muted">Eşleşen yok.</li>}
        </ul>
      </div>
    </div>
  );
}
