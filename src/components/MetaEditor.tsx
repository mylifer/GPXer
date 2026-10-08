import { useEffect, useId, useRef, useState } from "react";
import { attachmentName, type Activity, type FileMeta, type FileSummary } from "../api";
import { ACTIVITIES, activityOf } from "../types";
import { FLUSH_EVENT } from "../prefs";

interface Props {
  summary: FileSummary;
  meta: FileMeta;
  allTags: string[];
  allPeople: string[];
  onChange(meta: FileMeta): void;
  /** Belge iliştir / kaldır (yoksa bölüm gösterilmez). */
  onAttach?(): void;
  onDetach?(name: string): void;
  onOpenAttachment?(name: string): void;
}

/** Kaydın türü, etiketleri, birlikte olunan kişiler ve notu. */
export function MetaEditor({ summary, meta, allTags, allPeople, onChange, onAttach, onDetach, onOpenAttachment }: Props) {
  const [note, setNote] = useState(meta.note);
  // Kayıt ya da kayıtlı not değişince alan güncellenir (çizim sırasında; efektte
  // yapmak her seçimde fazladan bir güncelleme turu doğuruyordu).
  const [noteOf, setNoteOf] = useState({ path: summary.path, note: meta.note });
  if (noteOf.path !== summary.path || noteOf.note !== meta.note) {
    setNoteOf({ path: summary.path, note: meta.note });
    setNote(meta.note);
  }

  // Not yazmaya ara verilince kaydedilir; seçim değişir ya da panel kapanırsa
  // bekleyen not eski kayda yazılır (yalnızca alandan çıkınca kaydetmek,
  // odak kaybı olmadan seçim değişince yazılanı kaybettiriyordu).
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (note === meta.note) {
      pending.current = null;
      return;
    }
    const save = () => {
      pending.current = null;
      onChange({ ...meta, note });
    };
    pending.current = save;
    const t = setTimeout(save, 800);
    return () => clearTimeout(t);
  }, [note, meta, onChange]);
  useEffect(() => () => pending.current?.(), [summary.path]);
  // Kapanırken (güncelleme kurulumu, pencereyi kapatma) bekleyen not yazılır.
  useEffect(() => {
    const flush = () => pending.current?.();
    window.addEventListener(FLUSH_EVENT, flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener(FLUSH_EVENT, flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, []);

  const guessed = summary.activitySet ? null : activityOf(summary.activity);

  return (
    <div className="meta-editor">
      <label className="inline-select">
        Tür
        <select
          value={meta.activity ?? ""}
          onChange={(e) => onChange({ ...meta, activity: (e.target.value || null) as Activity | null })}
          title="Tür, istatistiklerin hangi eşiklerle hesaplanacağını da belirleyebilir (Ayarlar)"
        >
          <option value="">Otomatik{guessed ? ` (${guessed.label})` : ""}</option>
          {ACTIVITIES.filter((a) => a.id !== "unknown").map((a) => (
            <option key={a.id} value={a.id}>
              {a.icon} {a.label}
            </option>
          ))}
        </select>
      </label>
      <ChipBox
        label="Etiketler"
        items={meta.tags}
        all={allTags}
        placeholder="Etiket ekle…"
        removeLabel={(t) => `${t} etiketini kaldır`}
        onChange={(tags) => onChange({ ...meta, tags })}
      />
      <ChipBox
        label="Kişiler"
        items={meta.people ?? []}
        all={allPeople}
        placeholder="Kimlerle? Kişi ekle…"
        removeLabel={(t) => `${t} kişisini kaldır`}
        onChange={(people) => onChange({ ...meta, people })}
        people
      />
      {onAttach && (
        <div className="attachments" role="group" aria-label="Belgeler">
          {(meta.attachments ?? []).map((a) => (
            <span key={a} className="tag attachment">
              <button className="link" onClick={() => onOpenAttachment?.(a)} title="Aç" data-no-i18n>
                {`📎 ${attachmentName(a)}`}
              </button>
              {onDetach && (
                <button className="tag-x" onClick={() => onDetach(a)} aria-label={`${attachmentName(a)} belgesini kaldır`}>
                  ×
                </button>
              )}
            </span>
          ))}
          <button className="link small" onClick={onAttach} title="Bilet, fatura, giriş kartı, ses kaydı… kayda iliştirilir; yedeğe ve açık arşive dahildir">
            📎 Belge ekle…
          </button>
        </div>
      )}
      <textarea
        className="note"
        value={note}
        placeholder="Not…"
        rows={1}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => pending.current?.()}
      />
    </div>
  );
}

/** Yazılarak eklenen, × ile kaldırılan kısa adlar (etiket, kişi). */
function ChipBox({
  label,
  items,
  all,
  placeholder,
  removeLabel,
  onChange,
  people,
}: {
  label: string;
  items: string[];
  all: string[];
  placeholder: string;
  removeLabel(t: string): string;
  onChange(items: string[]): void;
  people?: boolean;
}) {
  const [text, setText] = useState("");
  const listId = useId();
  const add = () => {
    const t = text.trim();
    setText("");
    if (t && !items.some((x) => x.toLocaleLowerCase("tr-TR") === t.toLocaleLowerCase("tr-TR"))) onChange([...items, t]);
  };
  return (
    <div className={people ? "tag-box people-box" : "tag-box"} role="group" aria-label={label}>
      {items.map((t) => (
        <span key={t} className={people ? "tag person" : "tag"}>
          <span data-no-i18n>{people ? `👤 ${t}` : t}</span>
          <button className="tag-x" onClick={() => onChange(items.filter((x) => x !== t))} aria-label={removeLabel(t)}>
            ×
          </button>
        </span>
      ))}
      <input
        list={listId}
        value={text}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
      <datalist id={listId}>
        {all
          .filter((t) => !items.includes(t))
          .map((t) => (
            <option key={t} value={t} />
          ))}
      </datalist>
    </div>
  );
}
