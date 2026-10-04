import { Modal } from "./Modal";

/** macOS'ta ⌘, diğerlerinde Ctrl gösterilir. */
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

const KEYS: [string, string][] = [
  [`${MOD}+O`, "Dosya aç"],
  [`${MOD}+Shift+O`, "Klasör aç"],
  [`${MOD}+S`, "Seçili kaydı farklı kaydet (GPX, KML, TCX, FIT)"],
  [`${MOD}+E`, "Özet tablosunu dışa aktar (CSV)"],
  [`${MOD}+Shift+E`, "Harita görüntüsünü kaydet (PNG)"],
  [`${MOD}+0`, "Listede görünen tüm kayıtlara yakınlaştır"],
  [`${MOD}+B`, "Kenar çubuğunu aç/kapat"],
  [`${MOD}+I`, "Özet"],
  [`${MOD}+Shift+H`, "Isı haritası aç/kapat"],
  [`${MOD}+,`, "Ayarlar"],
  [`${MOD}+Shift+W`, "Kütüphaneyi boşalt"],
  ["↑ / ↓", "Listede önceki / sonraki kayıt"],
  ["Boşluk", "Seçili kaydı oynat / duraklat"],
  ["G", "Tarihe git: girilen tarih ve saatte neredeydim?"],
  ["Esc", "Alan seçmeyi, karşılaştırmayı, aralığı, çoklu seçimi ya da seçimi kaldır (bu sırayla)"],
  ["?", "Bu pencere"],
];

const MOUSE: [string, string][] = [
  ["Satıra çift tıklama", "Kaydı seçip haritada ona yakınlaştır"],
  [`${MOD}+tıklama`, "Birden çok kayıt seç (karşılaştırma, birleştirme, toplu etiket)"],
  ["Shift+tıklama", "Son tıklanan kayıttan buraya kadar olanları seç"],
  ["Grafikte sürükleme", "Bir aralık seç (aralık istatistiği, kırpma, bölme)"],
  ["Grafikte çift tıklama", "Aralık seçimini kaldır"],
  ["Haritada ize tıklama", "Kaydı seç; üst üste binen izlerde hangisinin seçileceği sorulur"],
  ["“⬚ Alan seç” açıkken haritada sürükleme", "Yalnızca o alandan geçen kayıtları listele"],
  ["Haritada sağ tıklama", "O yerin koordinatlarını kopyala (ondalık, derece-dakika-saniye ya da Google Haritalar bağlantısı) ya da tarayıcıda Google Street View / Yandex Panorama ile aç"],
  ["Paneli üst kenarından sürükleme", "Kayıt panelini büyüt / küçült"],
  ["Haritada duraklamaya ya da sık durulan yere tıklama", "“Bu yere ad ver…” (Ev, İş); yarıçap ve ad Ayarlar'da değiştirilir"],
  ["Kayıt panelinde duraklamaya tıklama", "Haritada o duraklamaya git; ✎ ile o yere ad ver"],
  ["“✈ Uçuşlar” açıkken uçuş yayına tıklama", "Kaydı seçip uçuşa yakınlaştır (Özet'teki uçuş listesinde de)"],
  ["Fotoğrafları haritaya sürükleyip bırakma", "Fotoğraf ekle; konum bilgisi olmayanlar çekim zamanına göre iz üzerine yerleşir"],
  ["Fotoğraf işaretine tıklama", "Büyük önizleme ve kaydı; sayılı işarette o fotoğraflara yakınlaştır"],
  ["Listede ⧉ işaretinin üzerine gelme", "Zamanı çakışan kayıtları gör; kayıt panelinden karşılaştır"],
];

export function HelpDialog({ onClose }: { onClose(): void }) {
  const table = (rows: [string, string][], keys: boolean) => (
    <table className="data-table help-table">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{keys ? <kbd>{k}</kbd> : k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <Modal title="Kısayollar ve fare hareketleri" onClose={onClose} wide>
      <div className="help">
        <h3>Klavye</h3>
        {table(KEYS, true)}
        <h3>Fare</h3>
        {table(MOUSE, false)}
      </div>
    </Modal>
  );
}
