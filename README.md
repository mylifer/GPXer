# GPXer

Windows ve macOS'ta çalışan, yüzlerce GPX günlüğünü aynı anda rahatça açabilen
bir GPX görüntüleyici. FIT (Garmin vb.), TCX ve KML dosyalarını da açar. [Tauri 2](https://tauri.app) (Rust) + React + MapLibre GL
ile yazılmıştır.

## Özellikler

**Harita**
- İz (track), rota (route) ve işaret noktaları (waypoint); sade, koyu, sokak,
  topoğrafik ve uydu altlıkları.
- İz üzerinde gezinince o noktanın tarihi ve saati görünür. Seçili izde
  mesafe, yükseklik, hız ve varsa nabız/kadans/güç/sıcaklık da gösterilir;
  grafikteki imleç de aynı noktaya gider.
- Üst üste binen izlere tıklayınca hangisinin seçileceği sorulur.
- Seçili iz hıza, yüksekliğe, nabza, kadansa ya da güce göre renklendirilebilir.
- Tüm izler dosya rengiyle ya da tarihe göre (eskiden yeniye) renklenir;
  dosya rengi değiştirilebilir ve kalıcıdır.
- Isı haritası: yüzlerce kayıtta en çok geçilen yerler.
- Harita görüntüsü PNG olarak kaydedilebilir.
- Duraklamalar: seçili kayıtta 2 dakikadan uzun duraklar haritada işaretlenir;
  *Duraklar* düğmesi tüm kayıtlarda en çok durulan yerleri gösterir.
- Alan filtresi: *⬚ Alan* ile haritada bir dikdörtgen çizilir, liste o alandan
  geçen kayıtlara süzülür ("buradan hangi günler geçtim").

**Grafik ve istatistik**
- Mesafe, toplam/hareket süresi, ortalama/maksimum hız, tempo, tırmanış/iniş,
  en düşük/en yüksek nokta; varsa ortalama/maksimum nabız, kadans, güç, sıcaklık.
- Yükseklik, hız, nabız, kadans, güç ve sıcaklık ortak eksenli ayrı
  şeritlerde; yatay eksen mesafe ya da zaman.
- Grafikte sürükleyerek aralık seçilir: aralığın mesafe, süre, hız, tırmanış
  ve nabız bilgisi; haritada vurgulama; aralığı kırpma ya da kaydı o noktadan
  bölme.
- Oynatma: iz, kaydın gerçek zamanına göre 10×–600× hızla canlandırılır,
  harita imleci takip eder.
- Özet paneli: aylık/yıllık mesafe, süre, tırmanış ve kayıt sayısı grafikleri
  (tabloya çevrilebilir), rekorlar. Çubuğa tıklayınca liste o döneme süzülür.
- Takvim: yılın her günü o günkü mesafeye göre renklenir; güne tıklayınca liste
  o güne süzülür.
- Tekrarlanan güzergâhlar: aynı yoldan yapılan kayıtlar kendiliğinden
  gruplanır; süreler zaman içinde, en iyi kayıt ve liste filtresiyle görülür.
- İki kaydı karşılaştırma: iki kayıt seçip *Karşılaştır*; hız/nabız vb. üst
  üste, her noktadaki zaman farkı ve aynı anda başlamış gibi "yarıştırma".
- Etkinlik türü (yürüyüş, koşu, bisiklet, araç) hız ve kadanstan tahmin edilir,
  elle değiştirilebilir; istenirse eşikler türe göre seçilir.
- GPS sıçramaları (bir anlığına uzağa fırlayıp dönen noktalar) hesaplardan
  ayıklanır; orijinal dosya değişmez.

**Kütüphane ve liste**
- Açılan dosyaların kopyası uygulamanın veri klasöründe saklanır ve her
  açılışta yüklenir; aynı kayıt (farklı adla kaydedilmiş olsa bile) ikinci kez
  eklenmez.
- Özetler önbelleğe alınır: değişmemiş dosyalar yeniden okunmaz.
- İzlenen klasörler: bu klasörlere eklenen yeni GPX/FIT/TCX/KML dosyaları kendiliğinden
  kütüphaneye girer.
- Liste aya ya da yıla göre gruplanır; grupların toplamları görünür.
- Her kaydın başlangıç ve bitiş yeri ("Kadıköy → Beşiktaş") çevrimdışı
  bulunur. Yer adları GeoNames verisinden gelir ve Latin harfleriyle yazılıdır;
  ü/ö düzeltilir, ş/ç/ğ/ı harfleri bazı adlarda eksik görünebilir.
- Etiketler ve notlar; tür ve etikete göre süzme; arama ad, yer, etiket ve
  notta yapılır. Çoklu seçimde toplu etiketleme.
- `gg.aa.yyyy` biçiminde tarih filtresi (yazarak ya da takvimden), hazır
  aralıklar (bugün, bu hafta, bu ay, son 30 gün, bu yıl…) ve yıl/ay seçimi.
- Ctrl/⌘ ve Shift ile çoklu seçim: birleştirme, CSV'ye aktarma,
  gösterme/gizleme, kaldırma.
- Kaldırılan kayıtlar çöp kutusuna gider; hemen "Geri al" ile geri gelir,
  30 gün sonra silinir.
- Filtreler, gizlenen izler, seçim, harita konumu ve panel boyutu açılışlar
  arasında hatırlanır.

**Dışa aktarma ve ayarlar**
- Özet tablosu CSV olarak (Türkçe Excel'in doğrudan açacağı biçimde), seçili
  kayıt GPX, KML (Google Earth) ya da TCX olarak kaydedilebilir. FIT, TCX ve
  KML dosyaları kütüphaneye GPX'e çevrilerek alınır.
- Ayarlar: etkinlik türüne göre hazır eşikler, duruyor sayılma hızı,
  yükseklik gürültü eşiği; saatlerin bilgisayarın ya da kaydın yapıldığı yerin
  saat dilimine göre gösterilmesi; izlenen klasörler.

**Açma yolları ve klavye**
- Sürükle-bırak, *Dosya Aç…* (Ctrl/⌘+O), *Klasör Aç…* (Ctrl/⌘+Shift+O),
  `.gpx`, `.fit`, `.tcx`, `.kml` dosyalarına çift tıklama.
- ↑/↓ listede gezinir, Boşluk oynatır/durdurur, Esc seçimi kaldırır,
  Ctrl/⌘+0 tümünü gösterir, Ctrl/⌘+B kenar çubuğu, Ctrl/⌘+H ısı haritası,
  Ctrl/⌘+I özet, Ctrl/⌘+E CSV, Ctrl/⌘+S GPX olarak kaydet, Ctrl/⌘+, ayarlar.

## Çok sayıda dosyada performans

- GPX dosyaları Rust tarafında akış tabanlı (streaming) bir XML ayrıştırıcıyla
  okunur ve tüm işlemci çekirdeklerinde paralel işlenir. Örnek ölçüm: toplam
  1,16 milyon nokta içeren 300 günlük log tek çekirdekte 0,7 saniyede yüklendi.
- Harita için her rota Douglas–Peucker ile ~4 m toleransla sadeleştirilir
  (örnekte 1,16 milyon nokta → 62 bin) ve tüm rotalar tek bir WebGL katmanında
  çizilir.
- Bellekte yalnızca özet ve sadeleştirilmiş çizgi tutulur. Grafik verisi bir
  dosya seçildiğinde yeniden okunur ve 4000 noktaya indirgenir (LTTB).

## Kurulum dosyalarını almak

Her push'ta GitHub Actions Windows (`.msi` ve `.exe`) ile macOS (`.dmg`,
Apple Silicon) kurulum dosyalarını üretir. Bunları
**Actions → Derleme → ilgili çalıştırma → Artifacts** bölümünden
indirebilirsiniz.

## Yeni sürüm yayımlamak

1. `package.json`, `src-tauri/Cargo.toml` ve `src-tauri/tauri.conf.json`
   içindeki sürümü artırın (ör. `0.2.1`).
2. Push'layın. O sürümün etiketi (`v0.2.1`) henüz yoksa derleme etiketi ve
   GitHub sürümünü kendisi oluşturur. İsterseniz etiketi elle de
   push'layabilirsiniz.
3. Kurulu uygulamalar açılışta yeni sürümü bulup güncellemeyi önerir
   (ya da menüden *Güncellemeleri Denetle…*).

Güncellemeler imzalıdır. Repo ayarlarında `TAURI_SIGNING_PRIVATE_KEY` ve
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` gizli değerleri tanımlı olmalıdır;
açık anahtar `tauri.conf.json` içindedir.

### Kod imzalama

İş akışı, aşağıdaki gizli değerler repo ayarlarında (*Settings → Secrets and
variables → Actions*) tanımlandığında paketleri kendiliğinden imzalar.
Tanımlı değilse paketler imzasız derlenir.

| Platform | Gizli değerler |
|---|---|
| macOS (Developer ID + noter onayı) | `APPLE_CERTIFICATE` (base64 .p12), `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (ör. `Developer ID Application: Ad (TEAMID)`), `APPLE_ID`, `APPLE_PASSWORD` (uygulamaya özel parola), `APPLE_TEAM_ID` |
| Windows (Authenticode) | `WINDOWS_CERTIFICATE` (base64 .pfx), `WINDOWS_CERTIFICATE_PASSWORD` |

Sertifika dosyasını base64'e çevirmek için: `base64 -i sertifika.p12 | pbcopy`
(macOS) ya da `[Convert]::ToBase64String([IO.File]::ReadAllBytes("sertifika.pfx"))`
(PowerShell).

İmza yokken:

- **Windows:** SmartScreen uyarısında *Ek bilgi → Yine de çalıştır*.
- **macOS:** ilk açılışta uygulamaya sağ tıklayıp *Aç* deyin. "Hasarlı"
  uyarısı çıkarsa Terminal'de `xattr -cr /Applications/GPXer.app`.

## Geliştirme

Gereksinimler: [Rust](https://rustup.rs), Node.js 20+ ve
[Tauri ön koşulları](https://tauri.app/start/prerequisites/)
(Windows'ta WebView2 ve MSVC Build Tools, macOS'ta Xcode Command Line Tools).

```sh
npm install
npm run tauri dev      # geliştirme modunda çalıştır
npm run tauri build    # bu işletim sistemi için kurulum dosyası üret
cargo test -p gpx-core -p gpxer # çekirdek ve uygulama testleri
```

Ölçüm/deneme aracı:

```sh
cargo run --release -p gpx-core --example dump -- ozet.json klasor/*.gpx
```

## Proje yapısı

```
crates/gpx-core/   GPX/FIT/TCX/KML okuma, GPX/KML/TCX yazma, istatistik, sıçrama temizleme,
                   duraklar, tür tahmini, sadeleştirme, kırpma/bölme/birleştirme
src-tauri/         Masaüstü uygulaması: komutlar, kütüphane ve önbellek, klasör izleme, menü
src/               React arayüzü (harita, liste, grafik, özet, ayarlar)
assets/icon.svg    Uygulama simgesi kaynağı (`npx tauri icon assets/icon.png`)
```

Harita altlıkları © OpenStreetMap katkıcıları, OpenFreeMap (OpenMapTiles), OpenTopoMap ve Esri'dir. Sade ve Koyu altlıklar vektördür; her yakınlaşmada keskin kalır (OpenFreeMap erişilemezse Esri raster altlığa dönülür).
İnternet bağlantısı olmadan rotalar yine çizilir, yalnızca altlık görünmez.
