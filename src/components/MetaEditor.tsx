import { useState } from "react";
import type { Activity, FileMeta, FileSummary } from "../api";
import { ACTIVITIES, activityOf } from "../types";

interface Props {
  summary: FileSummary;
  meta: FileMeta;
  allTags: string[];
  onChange(meta: FileMeta): void;
}

/** Kaydın türü, etiketleri ve notu. */
export function MetaEditor({ summary, meta, allTags, onChange }: Props) {
  const [tag, setTag] = useState("");
  const [note, setNote] = useState(meta.note);
  // Kayıt ya da kayıtlı not değişince alan güncellenir (çizim sırasında; efektte
  // yapmak her seçimde fazladan bir güncelleme turu doğuruyordu).
  const [noteOf, setNoteOf] = useState({ path: summary.path, note: meta.note });
  if (noteOf.path !== summary.path || noteOf.note !== meta.note) {
    setNoteOf({ path: summary.path, note: meta.note });
    setNote(meta.note);
  }

  const addTag = () => {
    const t = tag.trim();
    setTag("");
    if (t && !meta.tags.some((x) => x.toLocaleLowerCase("tr-TR") === t.toLocaleLowerCase("tr-TR"))) {
      onChange({ ...meta, tags: [...meta.tags, t] });
    }
  };
  const guessed = summary.activitySet ? null : activityOf(summary.activity);
  const listId = `tags-${summary.path.length}`;

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
      <div className="tag-box" role="group" aria-label="Etiketler">
        {meta.tags.map((t) => (
          <span key={t} className="tag">
            {t}
            <button
              className="tag-x"
              onClick={() => onChange({ ...meta, tags: meta.tags.filter((x) => x !== t) })}
              aria-label={`${t} etiketini kaldır`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          list={listId}
          value={tag}
          placeholder="Etiket ekle…"
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
        />
        <datalist id={listId}>
          {allTags
            .filter((t) => !meta.tags.includes(t))
            .map((t) => (
              <option key={t} value={t} />
            ))}
        </datalist>
      </div>
      <textarea
        className="note"
        value={note}
        placeholder="Not…"
        rows={1}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== meta.note && onChange({ ...meta, note })}
      />
    </div>
  );
}
