import type { Duplicate, LoadError } from "../hooks/useNotices";
import { fmtNumber } from "../format";
import { baseName } from "../lib/paths";

/** Sağ alttaki bildirimler: geri alma, klasör izleme önerisi, bilgi, kopyalar, hatalar. */
export function Toasts({
  undo,
  onUndo,
  watchOffer,
  onWatch,
  onDismissWatch,
  info,
  onCloseInfo,
  duplicates,
  onClearDuplicates,
  errors,
  onClearErrors,
}: {
  undo: { count: number } | null;
  onUndo(): void;
  watchOffer: string[] | null;
  onWatch(): void;
  onDismissWatch(): void;
  info: string | null;
  onCloseInfo(): void;
  duplicates: Duplicate[];
  onClearDuplicates(): void;
  errors: LoadError[];
  onClearErrors(): void;
}) {
  if (!(duplicates.length > 0 || errors.length > 0 || info || undo || watchOffer)) return null;
  return (
    <div className="toasts">
      {undo && (
        <div className="toast info">
          <div className="toast-head">
            <strong>{fmtNumber(undo.count)} kayıt kaldırıldı</strong>
            <button className="btn small primary" onClick={onUndo}>
              Geri al
            </button>
          </div>
        </div>
      )}
      {watchOffer && (
        <div className="toast info">
          <div className="toast-head">
            <strong>Bu klasör izlensin mi?</strong>
            <button className="icon-btn" onClick={onDismissWatch} title="Hayır">
              ×
            </button>
          </div>
          <div>Yeni eklenen GPX, FIT, TCX, KML dosyaları kütüphaneye kendiliğinden eklenir.</div>
          <div className="update-actions">
            <button className="btn small primary" onClick={onWatch}>
              İzle
            </button>
            <button className="btn small" onClick={onDismissWatch}>
              Hayır
            </button>
          </div>
        </div>
      )}
      {info && (
        <div className="toast info">
          <div className="toast-head">
            <span>{info}</span>
            <button className="icon-btn" onClick={onCloseInfo} title="Kapat">
              ×
            </button>
          </div>
        </div>
      )}
      {duplicates.length > 0 && (
        <div className="toast info">
          <div className="toast-head">
            <strong>{duplicates.length} dosya zaten kütüphanede, eklenmedi</strong>
            <button className="icon-btn" onClick={onClearDuplicates} title="Kapat">
              ×
            </button>
          </div>
          <ul>
            {duplicates.slice(0, 5).map((d, i) => (
              <li key={i}>
                <span className="path">{baseName(d.path)}</span> → {d.existing}
              </li>
            ))}
            {duplicates.length > 5 && <li>… ve {duplicates.length - 5} dosya daha</li>}
          </ul>
        </div>
      )}
      {errors.length > 0 && (
        <div className="toast error">
          <div className="toast-head">
            <strong>{errors.length === 1 && !errors[0].path ? "Bir sorun oluştu" : `${errors.length} sorun`}</strong>
            <button className="icon-btn" onClick={onClearErrors} title="Kapat">
              ×
            </button>
          </div>
          <ul>
            {errors.slice(0, 5).map((e, i) => (
              <li key={i}>
                {e.path && <span className="path">{baseName(e.path)}</span>} {e.message}
              </li>
            ))}
            {errors.length > 5 && <li>… ve {errors.length - 5} tane daha</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
