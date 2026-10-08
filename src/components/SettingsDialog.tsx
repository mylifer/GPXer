import { useEffect, useState } from "react";
import { lang, saveLang, t, type Lang } from "../i18n";
import { reportProblems } from "../hooks/useArchive";
import { saveUiMode, uiMode, type UiMode } from "../ui/mode";
import { CustomLayersEditor } from "./CustomLayersEditor";
import { FUEL_KINDS, type FuelKind, type FuelPrefs } from "../fuel";
import type { Goals, Prefs } from "../prefs";
import { archiveCheck, archiveInfo, backupNow, exportOpenArchive, clearTileCache, streetsInfo, syncInfo, tileCacheInfo, type ArchiveReport, type NamedPlace, type Settings } from "../api";
import { fmtBytes, fmtNumber, fmtTimestamp, type TzMode } from "../format";
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
  /** Kayıt bitince çözülür (dil değişince sayfa ondan sonra yenilenir). */
  onSave(s: Settings, prefs: Partial<Prefs>, places: NamedPlace[]): Promise<void>;
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
  /** Kayıtlı eşitleme klasörüyle şimdi eşitler. */
  onSyncNow(): Promise<void>;
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
  onSyncNow,
  places: initialPlaces,
}: Props) {
  const [places, setPlaces] = useState(initialPlaces);
  const editPlace = (id: string, patch: Partial<NamedPlace>) =>
    setPlaces((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const [movingKmh, setMovingKmh] = useState(r1(settings.stats.movingSpeedMs * 3.6));
  const [eleM, setEleM] = useState(settings.stats.elevationThresholdM);
  const [folders, setFolders] = useState(settings.watchedFolders);
  const [syncFolder, setSyncFolder] = useState<string | null>(settings.syncFolder ?? null);
  const [backupFolder, setBackupFolder] = useState<string | null>(settings.backupFolder ?? null);
  const [backupDays, setBackupDays] = useState(settings.backupDays || 7);
  const [archive, setArchive] = useState<{ busy?: string; report?: ArchiveReport; msg?: string; lastBackup?: number | null; lastCheck?: number | null }>({});
  useEffect(() => {
    archiveInfo()
      .then((i) => setArchive((a) => ({ ...a, lastBackup: i.lastBackup, lastCheck: i.lastCheck })))
      .catch(() => {});
  }, []);
  const [syncLast, setSyncLast] = useState<number | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  useEffect(() => {
    syncInfo()
      .then((i) => setSyncLast(i?.last ?? null))
      .catch(() => {});
  }, []);
  const [tz, setTz] = useState<TzMode>(prefs.tzMode);
  const [fuel, setFuel] = useState<FuelPrefs>(prefs.fuel);
  const [goals, setGoals] = useState<Goals>(prefs.goals);
  const [layers, setLayers] = useState(prefs.customLayers);
  const [language, setLanguage] = useState<Lang>(lang);
  const [ui, setUi] = useState<UiMode>(uiMode);
  const [clean, setClean] = useState(settings.stats.cleanSpikes);
  const [perType, setPerType] = useState(settings.stats.perType);
  const [stays, setStays] = useState(settings.stats.collapseStays);
  const preset = PRESETS.find((p) => p.movingKmh === movingKmh && p.eleM === eleM)?.id ?? "";

  const save = () => {
    // Dil değişince arayüz yeniden yüklenir (çeviri ve biçimler açılışta kurulur).
    // Dil ya da görünüm değişince arayüz yeniden yüklenir.
    const reload = language !== lang || ui !== uiMode;
    if (language !== lang) saveLang(language);
    if (ui !== uiMode) saveUiMode(ui);
    const saved = onSave(
      {
        ...settings,
        stats: {
          ...settings.stats,
          movingSpeedMs: Math.max(0, movingKmh) / 3.6,
          elevationThresholdM: Math.max(0, eleM),
          cleanSpikes: clean,
          perType,
          collapseStays: stays,
        },
        watchedFolders: folders,
        syncFolder,
        backupFolder,
        backupDays,
      },
      { tzMode: tz, customLayers: layers, goals: { km: Math.max(0, goals.km || 0), days: Math.max(0, goals.days || 0) }, fuel: { ...fuel, per100: Math.max(0, fuel.per100 || 0), price: Math.max(0, fuel.price || 0) } },
      places
        .map((x) => ({ ...x, name: x.name.trim(), radiusM: Math.max(10, Math.min(5000, Math.round(x.radiusM) || 150)) }))
        .filter((x) => x.name),
    );
    if (reload) void saved.finally(() => window.location.reload());
  };

  return (
    <Modal title="Ayarlar" onClose={onClose}>
      <div className="form">
        <fieldset>
          <legend>Görünüm ve dil</legend>
          <label className="field">
            <span>Arayüz</span>
            <select value={ui} onChange={(e) => setUi(e.target.value as UiMode)}>
              <option value="modern">Modern</option>
              <option value="classic">Klasik (ilk tasarım)</option>
            </select>
          </label>
          <label className="field">
            <span data-no-i18n>Dil / Language</span>
            <select value={language} onChange={(e) => setLanguage(e.target.value as Lang)} aria-label="Dil / Language" data-no-i18n>
              <option value="tr">Türkçe</option>
              <option value="en">English</option>
            </select>
          </label>
        </fieldset>

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
          <legend>Cihazlar arası eşitleme</legend>
          <small>
            Google Drive, iCloud Drive, Dropbox ya da OneDrive'daki bir klasör seçin; kayıtlar, etiket ve notlar, adlandırılmış
            yerler ve yer imleri bu klasör üzerinden öbür bilgisayarlarınızdaki GPXer ile eşitlenir (açılışta ve 15 dakikada
            bir). Her bilgisayarda aynı klasörü seçin. Bir cihazda silinen kayıt öbürlerinde çöp kutusuna taşınır.
          </small>
          {syncFolder ? (
            <ul className="folder-list">
              <li>
                <span title={syncFolder}>{syncFolder}</span>
                <button className="icon-btn" onClick={() => setSyncFolder(null)} title="Eşitlemeyi kapat">
                  ×
                </button>
              </li>
            </ul>
          ) : (
            <span className="muted small-note">Eşitleme kapalı.</span>
          )}
          <div className="form-actions" style={{ justifyContent: "flex-start" }}>
            <button
              className="btn small"
              onClick={async () => {
                const f = await onPickFolder();
                if (f) setSyncFolder(f);
              }}
            >
              {syncFolder ? "Klasörü değiştir…" : "Klasör seç…"}
            </button>
            <button
              className="btn small"
              disabled={!settings.syncFolder || syncFolder !== (settings.syncFolder ?? null) || syncBusy}
              title={syncFolder !== (settings.syncFolder ?? null) ? "Önce ayarları kaydedin" : undefined}
              onClick={async () => {
                setSyncBusy(true);
                await onSyncNow();
                setSyncBusy(false);
                syncInfo()
                  .then((i) => setSyncLast(i?.last ?? null))
                  .catch(() => {});
              }}
            >
              {syncBusy ? "Eşitleniyor…" : "Şimdi eşitle"}
            </button>
          </div>
          {syncLast != null && <small>Son eşitleme: {fmtTimestamp(syncLast, undefined)}</small>}
        </fieldset>

        <fieldset>
          <legend>Arşiv</legend>
          <small>
            Kayıtlarınızın içerik parmak izi saklanır; haftada bir (ya da “Arşivi denetle” ile) kaybolan ve bozulan dosyalar
            aranır. Bir klasör seçerseniz (harici disk, bulut klasörü) seçtiğiniz aralıkla otomatik yedek alınır; son 5 yedek
            kalır. Otomatik yedekler şifresizdir; şifreli yedek için Dosya menüsündeki Yedek al… kullanılır.
          </small>
          {backupFolder ? (
            <ul className="folder-list">
              <li>
                <span title={backupFolder}>{backupFolder}</span>
                <button className="icon-btn" onClick={() => setBackupFolder(null)} title="Otomatik yedeği kapat">
                  ×
                </button>
              </li>
            </ul>
          ) : (
            <span className="muted small-note">Otomatik yedek kapalı.</span>
          )}
          <div className="form-actions" style={{ justifyContent: "flex-start", flexWrap: "wrap" }}>
            <button
              className="btn small"
              onClick={async () => {
                const f = await onPickFolder();
                if (f) setBackupFolder(f);
              }}
            >
              {backupFolder ? "Klasörü değiştir…" : "Yedek klasörü seç…"}
            </button>
            <label className="inline-field">
              <span>Aralık</span>
              <select value={backupDays} onChange={(e) => setBackupDays(Number(e.target.value))} aria-label="Yedek aralığı">
                <option value={1}>Her gün</option>
                <option value={7}>Haftada bir</option>
                <option value={30}>Ayda bir</option>
              </select>
            </label>
            <button
              className="btn small"
              disabled={!settings.backupFolder || backupFolder !== (settings.backupFolder ?? null) || !!archive.busy}
              title={backupFolder !== (settings.backupFolder ?? null) ? "Önce ayarları kaydedin" : undefined}
              onClick={async () => {
                setArchive((a) => ({ ...a, busy: "backup", msg: undefined }));
                try {
                  const path = await backupNow();
                  setArchive((a) => ({ ...a, busy: undefined, lastBackup: Date.now(), msg: `${t("Yedek alındı:")} ${path}` }));
                } catch (e) {
                  setArchive((a) => ({ ...a, busy: undefined, msg: String(e) }));
                }
              }}
            >
              {archive.busy === "backup" ? "Yedekleniyor…" : "Şimdi yedekle"}
            </button>
            <button
              className="btn small"
              disabled={!!archive.busy}
              onClick={async () => {
                setArchive((a) => ({ ...a, busy: "check", msg: undefined }));
                try {
                  const report = await archiveCheck();
                  setArchive((a) => ({ ...a, busy: undefined, report, lastCheck: report.checkedAt }));
                } catch (e) {
                  setArchive((a) => ({ ...a, busy: undefined, msg: String(e) }));
                }
              }}
            >
              {archive.busy === "check" ? "Denetleniyor…" : "Arşivi denetle"}
            </button>
            <button
              className="btn small"
              disabled={!!archive.busy}
              title="Bütün arşivi GPXer olmadan da okunabilecek biçimde bir klasöre çıkarır: orijinal kayıt dosyaları, kayıt listesi (CSV), etiket ve notlar, yerler (JSON) ve tarayıcıda açılan dizin sayfası"
              onClick={async () => {
                setArchive((a) => ({ ...a, busy: "export", msg: undefined }));
                try {
                  const r = await exportOpenArchive();
                  setArchive((a) => ({ ...a, busy: undefined, msg: r ? t(`${fmtNumber(r.records)} kayıt açık arşiv olarak yazıldı: ${r.folder}`) : undefined }));
                } catch (e) {
                  setArchive((a) => ({ ...a, busy: undefined, msg: String(e) }));
                }
              }}
            >
              {archive.busy === "export" ? "Yazılıyor…" : "Açık arşiv olarak dışa aktar…"}
            </button>
          </div>
          {archive.report && (
            <div className={`hint${reportProblems(archive.report) ? " error" : ""}`} data-testid="archive-report">
              {reportProblems(archive.report) ?? t(`${fmtNumber(archive.report.total)} kaydın hepsi sağlam.`)}
            </div>
          )}
          {archive.msg && <div className="hint">{archive.msg}</div>}
          <small>
            {`${t("Son yedek:")} ${archive.lastBackup != null ? fmtTimestamp(archive.lastBackup, undefined) : t("hiç")}`}
            {archive.lastCheck != null && ` · ${t("Son denetim:")} ${fmtTimestamp(archive.lastCheck, undefined)}`}
          </small>
        </fieldset>

        <fieldset>
          <legend>Adlandırılmış yerler</legend>
          <small>
            Haritada bir duraklamaya ya da sık durulan yere tıklayıp “Bu yere ad ver…” ile eklenir. Yarıçap içinde başlayan
            ya da biten kayıtlar ve oradaki duraklamalar bu adla gösterilir (“Ev → İş”); Özet'te her yerde geçen süre
            listelenir. “Gizli” işaretli yerler (ör. ev) gizlilik bölgesidir: paylaşılan dosya ve görüntülerde çevresi
            kırpılır.
          </small>
          {places.length === 0 ? (
            <div className="muted">Adlandırılmış yer yok.</div>
          ) : (
            <table className="data-table compact places-table">
              <thead>
                <tr>
                  <th>Ad</th>
                  <th>Yarıçap (m)</th>
                  <th title="Gizlilik bölgesi: dışa aktarılan dosyalarda, harita görüntüsünde, videoda, yıl kartında ve gezi hikâyesinde bu yerin çevresi (en az 300 m) kırpılır">
                    Gizli
                  </th>
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
                      <input
                        type="checkbox"
                        checked={!!x.private}
                        onChange={(e) => editPlace(x.id, { private: e.target.checked })}
                        aria-label={`${x.name} gizlilik bölgesi`}
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
            Kayıtlar, etiketler, notlar, türler, adlandırdığınız yerler ve yer imleri tek bir .zip dosyasına (isteğe bağlı
            parolayla, AES-256) yedeklenir; başka bir
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
  const [names, setNames] = useState<number | null>(null);
  useEffect(() => {
    tileCacheInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
    streetsInfo()
      .then((r) => setNames(r?.[0] ?? null))
      .catch(() => {});
  }, []);
  return (
    <div className="row-actions">
      <span>
        {info ? `${fmtNumber(info.count)} karo · ${fmtBytes(info.bytes)}` : "—"}
        {names ? ` · aramada ${fmtNumber(names)} sokak ve yer` : ""}
      </span>
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
