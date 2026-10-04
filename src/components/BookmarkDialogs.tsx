import { useMemo, useState } from "react";
import type { Bookmark, FileSummary } from "../api";
import { visitedBookmarks } from "../bookmarks";
import { fmtDate, fmtLatLon } from "../format";
import { Modal } from "./Modal";

/** Yer imi ekleme / düzenleme. */
export function BookmarkEditor({
  mark,
  onSave,
  onDelete,
  onClose,
}: {
  mark: Bookmark;
  onSave(b: Bookmark): void;
  onDelete?: () => void;
  onClose(): void;
}) {
  const [name, setName] = useState(mark.name);
  const [note, setNote] = useState(mark.note);
  const [wish, setWish] = useState(mark.wish);
  return (
    <Modal title={onDelete ? "Yer imini düzenle" : "Yer imi koy"} onClose={onClose}>
      <div className="form">
        <p className="muted small-note">{fmtLatLon(mark.lat, mark.lon)}</p>
        <label className="field">
          <span>Ad</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="ör. Kapadokya balon turu" />
        </label>
        <label className="field">
          <span>Not</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={wish} onChange={(e) => setWish(e.target.checked)} />
          Gitmek istediğim yer
        </label>
        <div className="modal-actions">
          {onDelete && (
            <button className="btn danger" onClick={onDelete}>
              Sil
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => onSave({ ...mark, name: name.trim(), note, wish })}>
            Kaydet
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Yer imleri listesi: gidilenler işaretli; tıklayınca haritada gösterilir. */
export function BookmarkList({
  marks,
  files,
  onGo,
  onEdit,
  onClose,
}: {
  marks: Bookmark[];
  files: FileSummary[];
  onGo(b: Bookmark): void;
  onEdit(b: Bookmark): void;
  onClose(): void;
}) {
  const [only, setOnly] = useState<"all" | "wish">("all");
  const visited = useMemo(() => visitedBookmarks(marks, files), [marks, files]);
  const shown = marks.filter((m) => only === "all" || m.wish).sort((a, b) => a.name.localeCompare(b.name, "tr"));
  return (
    <Modal title="Yer imleri" onClose={onClose}>
      <div className="segmented small">
        <button className={only === "all" ? "active" : ""} onClick={() => setOnly("all")}>
          Tümü ({marks.length})
        </button>
        <button className={only === "wish" ? "active" : ""} onClick={() => setOnly("wish")}>
          Gitmek istediklerim ({marks.filter((m) => m.wish).length})
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="muted small-note">Henüz yer imi yok. Haritada sağ tıklayıp “Buraya yer imi koy…” seçin.</p>
      ) : (
        <ul className="bookmark-list">
          {shown.map((m) => {
            const v = visited.get(m.id);
            return (
              <li key={m.id}>
                <button className="link" onClick={() => onGo(m)} title="Haritada göster">
                  {m.wish ? "⭐" : "📌"} <strong data-no-i18n>{m.name}</strong>
                  {v != null && <span className="badge">gidildi{v ? ` · ${fmtDate(v)}` : ""}</span>}
                  {m.note && (
                    <div className="muted small" data-no-i18n>
                      {m.note}
                    </div>
                  )}
                </button>
                <button className="icon-btn tiny" onClick={() => onEdit(m)} aria-label={`${m.name} düzenle`}>
                  ✎
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
