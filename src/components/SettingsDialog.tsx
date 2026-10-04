import { useEffect, useState } from "react";
import { CustomLayersEditor } from "./CustomLayersEditor";
import { FUEL_KINDS, type FuelKind, type FuelPrefs } from "../fuel";
import type { Goals, Prefs } from "../prefs";
import { clearTileCache, tileCacheInfo, type NamedPlace, type Settings } from "../api";
import { fmtBytes, fmtNumber, type TzMode } from "../format";
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
  /** Arayüz tercihleri (bu pencerede düzenlenenler). */
  prefs: Prefs;
  onSave(s: Settings, prefs: Partial<Prefs>, places: NamedPlace[]): void;
  /** Adlandırılmış yerler (ad, yarıçap düzenlenir, silinir). */
  places: NamedPlace[];
  onPickFolder(): Promise<string | null>;
  onClose(): void;
  /** Kütüphanedeki kayıt sayısı (boşaltma düğmesi için). */
  libraryCount: number;
  /** Kütüphanenin tamamını kaldırır (onay ayrıca sorulur). */
  onClearLibrary(): void;
  /** Kütüphaneyi tek dosyaya yedekler / yedekten geri yükler. */
  onBackup(): void;
  onRestore(): void;
}

export function SettingsDialog({
  settings,
  prefs,
  onSave,
  onPickFolder,
  onClose,
  libraryCount,
  onClearLibrary,
  onBackup,
  onRestore,
  places: initialPlaces,
}: Props) {
  const [places, setPlaces] = useState(initialPlaces);
  const editPlace = (id: string, patch: Partial<NamedPlace>) =>
    setPlaces((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const [movingKmh, setMovingKmh] = useState(r1(settings.stats.movingSpeedMs * 3.6));
  const [eleM, setEleM] = useState(settings.stats.elevationThresholdM);
  const [folders, setFolders] = useState(settings.watchedFolders);
  const [tz, setTz] = useState<TzMode>(prefs.tzMode);
  const [fuel, setFuel] = useState<FuelPrefs>(prefs.fuel);
  const [goals, setGoals] = useState<Goals>(prefs.goals);
  const [layers, setLayers] = useState(prefs.customLayers);
  const [clean, setClean] = useState(settings.stats.cleanSpikes);
  const [perType, setPerType] = useState(settings.stats.perType);
  const [stays, setStays] = useState(settings.stats.collapseStays);
  const preset = PRESETS.find((p) => p.movingKmh === movingKmh && p.eleM === eleM)?.id ?? "";

  const save = () =>
    onSave(
      {
        stats: {
          movingSpeedMs: Math.max(0, movingKmh) / 3.6,
          elevationThresholdM: Math.max(0, eleM),
          cleanSpikes: clean,
          perType,
          collapseStays: stays,
        },
        watchedFolders: folders,
      },
      { tzMode: tz, customLayers: layers, goals: { km: Math.max(0, goals.km || 0), days: Math.max(0, goals.days || 0) }, fuel: { ...fuel, per100: Math.max(0, fuel.per100 || 0), price: Math.max(0, fuel.price || 0) } },
      places
        .map((x) => ({ ...x, name: x.name.trim(), radiusM: Math.max(10, Math.min(5000, Math.round(x.radiusM) || 150)) }))
        .filter((x) => x.name),
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
            GPS gürültüsünü temizle
          </label>
          <small>
            GPS sıçramaları (izden bir anlığına uzağa fırlayıp geri dönen ya da akla yatkın olmayan hızla atlayan
            noktalar) haritadan ve hesaplardan çıkarılır. Orijinal dosya değişmez. Değiştirince tüm kayıtlar yeniden
            hesaplanır.
          </small>
          <label className="check sub-check">
            <input type="checkbox" checked={stays} disabled={!clean} onChange={(e) => setStays(e.target.checked)} />
            Uzun duraklamalardaki titremeyi tek noktaya indir
          </label>
          <small>
            Bir yerde 10 dakikadan uzun süre 120 m içinde kalındığında (ev, iş yeri) GPS konumu oynar ve iz yumak gibi
            görünür; bu aralık duraklamanın merkezindeki tek noktaya indirilir. Mesafe ve hareket süresi de düzelir.
          </small>
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
          <legend>Çevrimdışı harita</legend>
          <small>
            Haritada görülen yerlerin karoları bilgisayarda saklanır ve internet yokken de açılır (en çok 2 GB; eskiler
            kendiliğinden silinir). Bir bölgeyi önceden indirmek için: Katmanlar ▾ → Görünen alanı çevrimdışı için indir.
          </small>
          <TileCacheInfo />
        </fieldset>

        <fieldset>
          <legend>Harita katmanları</legend>
          <small>
            Kendi karo (XYZ, ör. <code>https://…/{"{z}/{x}/{y}"}.png</code>) ya da WMS adresinizi ekleyin; katman altlığın
            üstünde, izlerin altında çizilir ve Katmanlar ▾ menüsünden açılıp kapatılır.
          </small>
          <CustomLayersEditor layers={layers} onChange={setLayers} />
        </fieldset>

        <fieldset>
          <legend>Yıllık hedefler</legend>
          <div className="field-row">
            <label className="field">
              <span>Mesafe (km)</span>
              <input type="number" min={0} step={100} value={goals.km} onChange={(e) => setGoals({ ...goals, km: e.target.valueAsNumber })} />
            </label>
            <label className="field">
              <span>Yolda geçen gün</span>
              <input type="number" min={0} step={1} value={goals.days} onChange={(e) => setGoals({ ...goals, days: e.target.valueAsNumber })} />
            </label>
          </div>
          <small>Özet'in başında bu yılki ilerleme ve takvime göre önde mi geride mi olduğunuz gösterilir. 0: hedef yok.</small>
        </fieldset>

        <fieldset>
          <legend>Yakıt (araç kayıtları)</legend>
          <div className="field-row">
            <label className="field">
              <span>Yakıt</span>
              <select value={fuel.kind} onChange={(e) => setFuel({ ...fuel, kind: e.target.value as FuelKind })}>
                {FUEL_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>100 km'de ({FUEL_KINDS.find((k) => k.id === fuel.kind)?.unit})</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={fuel.per100}
                onChange={(e) => setFuel({ ...fuel, per100: e.target.valueAsNumber })}
              />
            </label>
            <label className="field">
              <span>Birim fiyat (₺)</span>
              <input
                type="number"
                min={0}
                step={0.1}
                value={fuel.price}
                onChange={(e) => setFuel({ ...fuel, price: e.target.valueAsNumber })}
              />
            </label>
          </div>
          <small>Araç türündeki kayıtlarda tahmini yakıt, maliyet ve CO₂ salımı gösterilir (kayıt panelinde ve Özet'te).</small>
        </fieldset>

        <fieldset>
          <legend>İzlenen klasörler</legend>
          <small>
            Bu klasörlere (alt klasörler dahil) eklenen GPX, FIT, TCX ve KML dosyaları kütüphaneye kendiliğinden eklenir ve
            bildirilir. Telefondaki kayıt uygulaması dosyaları OneDrive, iCloud Drive, Google Drive ya da Dropbox'a
            kaydediyorsa o klasörü buraya ekleyin: telefonda biten kayıt bilgisayara kendiliğinden gelir.
          </small>
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

        <fieldset>
          <legend>Adlandırılmış yerler</legend>
          <small>
            Haritada bir duraklamaya ya da sık durulan yere tıklayıp “Bu yere ad ver…” ile eklenir. Yarıçap içinde başlayan
            ya da biten kayıtlar ve oradaki duraklamalar bu adla gösterilir (“Ev → İş”); Özet'te her yerde geçen süre
            listelenir.
          </small>
          {places.length === 0 ? (
            <div className="muted">Adlandırılmış yer yok.</div>
          ) : (
            <table className="data-table compact places-table">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Yarıçap (m)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {places.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <input
                        value={x.name}
                        onChange={(e) => editPlace(x.id, { name: e.target.value })}
                        aria-label="Yerin adı"
                        title={`${x.lat.toFixed(5)}, ${x.lon.toFixed(5)}`}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        min={10}
                        max={5000}
                        step={10}
                        value={x.radiusM}
                        onChange={(e) => editPlace(x.id, { radiusM: Number(e.target.value) })}
                        aria-label="Yarıçap (m)"
                      />
                    </td>
                    <td>
                      <button
                        className="icon-btn"
                        onClick={() => setPlaces((list) => list.filter((y) => y.id !== x.id))}
                        title="Yeri sil"
                        aria-label={`${x.name} yerini sil`}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </fieldset>

        <fieldset>
          <legend>Yedekleme</legend>
          <small>
            Kayıtlar, etiketler, notlar, türler ve adlandırdığınız yerler tek bir .zip dosyasına yedeklenir; başka bir
            bilgisayarda (Mac ↔ Windows) geri yüklenebilir. Geri yüklemede kütüphanede zaten olan kayıtlar atlanır, bilgiler
            mevcut olanlarla birleştirilir. Ayarlar (izlenen klasörler) yedeklenmez.
          </small>
          <div className="filter-row">
            <button className="btn small" onClick={onBackup} disabled={libraryCount === 0}>
              Yedek al…
            </button>
            <button className="btn small" onClick={onRestore}>
              Yedekten geri yükle…
            </button>
          </div>
        </fieldset>

        <fieldset className="danger-zone">
          <legend>Kütüphane</legend>
          <small>
            Kütüphanedeki tüm kayıtları ({libraryCount}) listeden kaldırır. Orijinal dosyalarınız silinmez; hemen
            ardından “Geri al” ile geri getirebilirsiniz.
          </small>
          <button className="btn small danger" onClick={onClearLibrary} disabled={libraryCount === 0}>
            Kütüphaneyi boşalt…
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

/** Karo önbelleğinin boyutu ve temizleme düğmesi. */
function TileCacheInfo() {
  const [info, setInfo] = useState<{ bytes: number; count: number } | null>(null);
  useEffect(() => {
    tileCacheInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);
  return (
    <div className="row-actions">
      <span>{info ? `${fmtNumber(info.count)} karo · ${fmtBytes(info.bytes)}` : "—"}</span>
      <button
        className="btn small"
        disabled={!info?.count}
        onClick={() =>
          clearTileCache()
            .then(() => setInfo({ bytes: 0, count: 0 }))
            .catch(() => {})
        }
      >
        Önbelleği temizle
      </button>
    </div>
  );
}
