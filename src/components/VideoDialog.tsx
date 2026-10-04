import { useRef, useState } from "react";
import { videoMime } from "../map/video";
import { Modal } from "./Modal";

const LENGTHS = [15, 30, 60];

/** Seçili kaydın yolculuk videosu: süre seçilir, harita kaydı çizerken kaydedilir. */
export function VideoDialog({
  onRecord,
  onClose,
}: {
  onRecord(seconds: number, onProgress: (p: number) => void, signal: AbortSignal): Promise<void>;
  onClose(): void;
}) {
  const [seconds, setSeconds] = useState(30);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);
  const mime = videoMime();
  const ext = mime?.includes("mp4") ? "MP4" : "WebM";
  const start = async () => {
    abort.current = new AbortController();
    setProgress(0);
    try {
      await onRecord(seconds, setProgress, abort.current.signal);
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };
  return (
    <Modal
      title="Yolculuk videosu"
      onClose={() => {
        abort.current?.abort();
        onClose();
      }}
    >
      {!mime ? (
        <p className="error">Bu sistemin tarayıcı bileşeni video kaydını desteklemiyor.</p>
      ) : (
        <div className="form">
          <p className="muted small-note">
            Harita kaydın tamamını gösterecek şekilde yerleşir; iz baştan sona çizilirken ekran {ext} olarak kaydedilir.
            Üstte kaydın adı, saat ve gidilen mesafe yazar. Kayıt boyunca haritayı oynatmayın.
          </p>
          <label className="field">
            <span>Video süresi</span>
            <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={progress != null}>
              {LENGTHS.map((s) => (
                <option key={s} value={s}>
                  {s} saniye
                </option>
              ))}
            </select>
          </label>
          {progress != null && (
            <div className="province-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)}>
              <div style={{ width: `${progress * 100}%` }} />
            </div>
          )}
          <div className="modal-actions">
            {progress != null ? (
              <button className="btn" onClick={() => abort.current?.abort()}>
                Durdur
              </button>
            ) : (
              <button className="btn primary" onClick={start}>
                🎥 Kaydı başlat
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
