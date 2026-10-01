import { useState } from "react";
import type { Settings } from "../api";
import type { TzMode } from "../format";
import { Modal } from "./Modal";

/** Etkinlik türüne göre hazır eşikler. */
const PRESETS: { id: string; label: string; movingKmh: number; eleM: number }[] = [
  { id: "walk", label: "Yürüyüş / doğa yürüyüşü", movingKmh: 1.0, eleM: 5 },
  { id: "run", label: "Koşu", movingKmh: 2.5, eleM: 3 },
  { id: "bike", label: "Bisiklet", movingKmh: 3.5, eleM: 3 },
  { id: "car", label: "Araç / motosiklet", movingKmh: 6.0, eleM: 5 },
  { id: "default", label: "Varsayılan", movingKmh: 1.8, eleM: 3 },
];

const r1 = (v: number) => Math.round(v * 10) / 10;

interface Props {
  settings: Settings;
  tzMode: TzMode;
  onSave(s: Settings, tzMode: TzMode): void;
  onPickFolder(): Promise<string | null>;
  onClose(): void;
}

export function SettingsDialog({ settings, tzMode, onSave, onPickFolder, onClose }: Props) {
  const [movingKmh, setMovingKmh] = useState(r1(settings.stats.movingSpeedMs * 3.6));
  const [eleM, setEleM] = useState(settings.stats.elevationThresholdM);
  const [folders, setFolders] = useState(settings.watchedFolders);
  const [tz, setTz] = useState<TzMode>(tzMode);
  const [clean, setClean] = useState(settings.stats.cleanSpikes);
  const [perType, setPerType] = useState(settings.stats.perType);
  const preset = PRESETS.find((p) => p.movingKmh === movingKmh && p.eleM === eleM)?.id ?? "";

  const save = () =>
    onSave(
      {
        stats: {
          movingSpeedMs: Math.max(0, movingKmh) / 3.6,
          elevationThresholdM: Math.max(0, eleM),
          cleanSpikes: clean,
          perType,
        },
        watchedFolders: folders,
      },
      tz,
    );

  return (
    <Modal title="Ayarlar" onClose={onClose}>
      <div className="form">
        <fieldset>
          <legend>Hesaplama</legend>
          <label className="field">
            <span>Etkinlik türü</span>
            <select
              value={preset}
              onChange={(e) => {
                const p = PRESETS.find((x) => x.id === e.target.value);
                if (p) {
                  setMovingKmh(p.movingKmh);
                  setEleM(p.eleM);
                }
              }}
            >
              <option value="">Özel</option>
              {PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Duruyor sayılma hızı (km/sa)</span>
            <input
              type="number"
              min={0}
              step={0.1}
              value={movingKmh}
              onChange={(e) => setMovingKmh(Number(e.target.value))}
            />
            <small>Bu hızın altındaki anlar hareket süresine ve ortalama hıza katılmaz.</small>
          </label>
          <label className="field">
            <span>Yükseklik gürültü eşiği (m)</span>
            <input type="number" min={0} step={0.5} value={eleM} onChange={(e) => setEleM(Number(e.target.value))} />
            <small>Bundan küçük iniş çıkışlar tırmanışa/inişe sayılmaz. GPS yüksekliği için 3–5 m uygundur.</small>
          </label>
          <label className="check">
            <input type="checkbox" checked={perType} onChange={(e) => setPerType(e.target.checked)} />
            Eşikleri her kaydın etkinlik türüne göre seç
          </label>
          <small>
            Açıkken yürüyüş, koşu, bisiklet ve araç kayıtları kendi hazır eşikleriyle hesaplanır; tür, kayıt
            panelinden değiştirilebilir. Türü bilinmeyen kayıtlarda yukarıdaki değerler kullanılır.
          </small>
          <label className="check">
            <input type="checkbox" checked={clean} onChange={(e) => setClean(e.target.checked)} />
            GPS sıçramalarını temizle
          </label>
          <small>İzden bir anlığına uzağa fırlayıp geri dönen ya da akla yatkın olmayan hızla atlayan noktalar hesaplara katılmaz. Orijinal dosya değişmez.</small>
        </fieldset>

        <fieldset>
          <legend>Saatler</legend>
          <label className="radio">
            <input type="radio" checked={tz === "local"} onChange={() => setTz("local")} />
            Bilgisayarın saat dilimine göre göster
          </label>
          <label className="radio">
            <input type="radio" checked={tz === "record"} onChange={() => setTz("record")} />
            Kaydın yapıldığı yerin saat dilimine göre göster
          </label>
          <small>Başka bir ülkede kaydedilen loglarda ikinci seçenek yerel saati doğru gösterir.</small>
        </fieldset>

        <fieldset>
          <legend>İzlenen klasörler</legend>
          <small>Bu klasörlere (alt klasörler dahil) eklenen GPX, FIT, TCX ve KML dosyaları kütüphaneye kendiliğinden eklenir.</small>
          <ul className="folder-list">
            {folders.map((f) => (
              <li key={f}>
                <span title={f}>{f}</span>
                <button className="icon-btn" onClick={() => setFolders(folders.filter((x) => x !== f))} title="İzlemeyi bırak">
                  ×
                </button>
              </li>
            ))}
            {folders.length === 0 && <li className="muted">İzlenen klasör yok.</li>}
          </ul>
          <button
            className="btn small"
            onClick={async () => {
              const f = await onPickFolder();
              if (f && !folders.includes(f)) setFolders([...folders, f]);
            }}
          >
            Klasör ekle…
          </button>
        </fieldset>

        <div className="form-actions">
          <button className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button className="btn primary" onClick={save}>
            Kaydet
          </button>
        </div>
      </div>
    </Modal>
  );
}
