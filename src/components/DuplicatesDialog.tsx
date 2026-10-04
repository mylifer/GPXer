import { useState } from "react";
import type { DuplicateGroup } from "../duplicates";
import type { FileEntry } from "../types";
import { fmtDate, fmtDistance, fmtNumber, tzOf } from "../format";
import { Modal } from "./Modal";

interface Props {
  groups: DuplicateGroup[];
  files: Map<string, FileEntry>;
  onOpen(path: string): void;
  onRemove(paths: string[]): void;
  onClose(): void;
}

/** Aynı yolculuğun kopyaları: hangilerinin tutulacağı seçilir, diğerleri
 * kütüphaneden kaldırılır (çöp kutusuna; geri alınabilir). */
export function DuplicatesDialog({ groups, files, onOpen, onRemove, onClose }: Props) {
  const [keep, setKeep] = useState(() => new Set(groups.flatMap((g) => g.keep)));
  const all = groups.flatMap((g) => g.paths).filter((p) => files.has(p));
  const drop = all.filter((p) => !keep.has(p));
  const toggle = (p: string) =>
    setKeep((k) => {
      const n = new Set(k);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  return (
    <Modal title="Kopya kayıtlar" onClose={onClose} wide>
      <p className="muted small-note">
        Aynı yolculuğun farklı adla ya da biraz farklı kesilmiş kopyaları. Önerilen, diğerlerini tümüyle kapsayan (en çok
        noktalı) kayıt; işaretli olanlar tutulur. Kaldırılanlar çöp kutusuna gider, hemen ardından “Geri al” ile geri
        getirilebilir. Orijinal dosyalarınız etkilenmez.
      </p>
      {groups.map((g, gi) => {
        const rows = g.paths.map((p) => files.get(p)).filter((f): f is FileEntry => !!f);
        const none = rows.every((f) => !keep.has(f.summary.path));
        return (
          <div key={gi} className="dup-group">
            <table className="dup-table">
              <thead>
                <tr>
                  <th>Tut</th>
                  <th>Kayıt</th>
                  <th>Tarih</th>
                  <th>Nokta</th>
                  <th>Mesafe</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const s = f.summary;
                  const z = tzOf(s);
                  const days =
                    s.stats.startTime != null
                      ? `${fmtDate(s.stats.startTime, z)}${
                          s.stats.endTime != null && fmtDate(s.stats.endTime, z) !== fmtDate(s.stats.startTime, z)
                            ? ` – ${fmtDate(s.stats.endTime, z)}`
                            : ""
                        }`
                      : "Tarihsiz";
                  return (
                    <tr key={s.path} className={keep.has(s.path) ? "" : "dropped"}>
                      <td>
                        <input
                          type="checkbox"
                          checked={keep.has(s.path)}
                          onChange={() => toggle(s.path)}
                          aria-label={`${s.name || s.fileName} tutulsun`}
                        />
                      </td>
                      <td>
                        <span className="swatch" style={{ background: f.color }} /> <span data-no-i18n>{s.name || s.fileName}</span>
                        {g.keep.includes(s.path) && <span className="badge">önerilen</span>}
                        <div className="muted small">{s.fileName}</div>
                      </td>
                      <td>{days}</td>
                      <td>{fmtNumber(s.stats.pointCount)}</td>
                      <td>{fmtDistance(s.stats.distanceM)}</td>
                      <td>
                        <button className="link" onClick={() => onOpen(s.path)}>
                          Göster
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {none && <div className="error small-note">Bu gruptan hiçbiri tutulmuyor: yolculuk tümüyle kaldırılacak.</div>}
          </div>
        );
      })}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Vazgeç
        </button>
        <button className="btn primary" disabled={drop.length === 0} onClick={() => onRemove(drop)}>
          {drop.length ? `${fmtNumber(drop.length)} kaydı kaldır` : "Kaldırılacak kayıt yok"}
        </button>
      </div>
    </Modal>
  );
}
