# GPXer

Windows ve macOS'ta çalışan, yüzlerce GPX günlüğünü aynı anda rahatça açabilen
bir GPX görüntüleyici. FIT (Garmin vb.), TCX ve KML dosyalarını ve Google Konum Geçmişi (Takeout `Records.json`, aylık anlamsal geçmiş, telefondaki Zaman Çizelgesi dışa aktarımı) JSON dosyalarını da açar. [Tauri 2](https://tauri.app) (Rust) + React + MapLibre GL
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
- Duraklamalar: seçili kayıtta 2 dakikadan uzun duraklamalar haritada
  işaretlenir; *Duraklamalar* düğmesi tüm kayıtlarda en sık duraklanan yerleri
  gösterir.
- Alan filtresi: *⬚ Alan seç* ile haritada bir dikdörtgen çizilir, liste o
  alandan geçen kayıtlara filtrelenir ("buradan hangi günler geçtim").

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
  (tabloya çevrilebilir), rekorlar. Çubuğa tıklayınca liste o döneme filtrelenir.
- Takvim: yılın her günü o günkü mesafeye göre renklenir; güne tıklayınca liste
  o güne filtrelenir.
- Çok günlük kayıtlar (aylarca, yıllarca süren telefon kayıtları) gün gün
  sayılır: takvim, tarih filtresi, özet grafikleri ve toplamlar her günün
  gerçek mesafesini kullanır. Tarih filtresi açıkken haritada kaydın yalnızca
  o tarihlere düşen kısmı çizilir; listede "bu aralıkta X km" görünür. Kayıt
  panelindeki *Gün* seçiciyle (‹ › düğmeleriyle) kaydın tek bir günü seçilir,
  istatistikleri görülür, haritada gösterilir, kırpılabilir.
- Tekrarlanan güzergâhlar: aynı yoldan yapılan kayıtlar kendiliğinden
  gruplanır; süreler zaman içinde, en iyi kayıt ve liste filtresiyle görülür.
- İki kaydı karşılaştırma: iki kayıt seçip *Karşılaştır*; hız/nabız vb. üst
  üste, her noktadaki zaman farkı ve aynı anda başlamış gibi "yarıştırma".
- Etkinlik türü (yürüyüş, koşu, bisiklet, araç) hız ve kadanstan tahmin edilir,
  elle değiştirilebilir; istenirse eşikler türe göre seçilir.
- GPS gürültüsü temizlenir: izden bir ya da birkaç noktalığına uzağa çıkıp
  geri dönen noktalar ve segment başındaki/sonundaki kopuk konumlar atılır;
  düz giden hızlı hareket (uçak, tren) korunur. Bir yerde 10 dakikadan uzun
  süre 120 m içinde kalındığında (ev, iş yeri) oluşan konum titremesi
  duraklamanın merkezindeki tek noktaya indirilir. Harita araç çubuğundaki
  *GPS gürültüsünü temizle* kutusuyla açılıp kapatılır (duraklama kısmı
  Ayarlar'dan ayrıca kapatılabilir); orijinal dosya değişmez.
- Kayıt boşlukları (uçuş, sinyal kaybı: 10 dakikadan uzun ve 2 km'den uzak ya
  da uçuş hızında 20 km'den uzun iki nokta arası) izi böler; haritada düz
  çizgiyle birleştirilmez. Seçili kayıtta boşluklar kesik çizgiyle gösterilir,
  üstüne gelince süresi ve mesafesi görünür; araç çubuğundaki *Boşluklar*
  kutusuyla gizlenebilir.

**Yolculuklar, yerler ve fotoğraflar**
- Uçuşlar: kayıttaki uçuş hızındaki boşluklar uçuş olarak listelenir (Özet →
  ✈ Uçuşlar: tarih, nereden → nereye, mesafe, süre, yıllık toplam);
  *✈ Uçuşlar* düğmesi haritada yay olarak çizer.
- Yerlere ad verme: bir duraklamaya ya da sık duraklanan yere tıklayıp *Bu
  yere ad ver…* (ör. Ev, İş). Adlar başlangıç/bitiş yerlerinde ve aramada
  kullanılır; Özet'te "Yerlerde geçen süre" aylık tablosu; Ayarlar'da düzenleme.
- *🕑 Tarihe git* (G): bir tarih ve saat girilir, o anda hangi kayıtta ve nerede
  olduğunuz haritada gösterilir.
- Gezilen ülkeler ve şehirler: Özet'te yıl yıl ülkeler (gün sayısıyla), en çok
  bulunulan şehirler ve ilk ziyaret tarihleri.
- Fotoğraflar: *📷 Fotoğraf ekle* (ya da fotoğrafları pencereye bırakın).
  Konumu olan fotoğraflar oraya, olmayanlar çekim saatine göre ize yerleşir;
  fotoğraf makinesinin saati yanlışsa ± saat düzeltmesi yapılabilir.
- Çakışan kayıtlar: aynı zaman aralığını içeren kayıtlar (ör. günlük kayıt ve
  uzun telefon kaydı) ⧉ ile işaretlenir, *⧉ Çakışanlar* ile filtrelenir,
  karşılaştırılabilir.

**Kütüphane ve liste**
- Açılan dosyaların kopyası uygulamanın veri klasöründe saklanır ve her
  açılışta yüklenir; aynı kayıt (farklı adla kaydedilmiş olsa bile) ikinci kez
  eklenmez.
- Özetler önbelleğe alınır: değişmemiş dosyalar yeniden okunmaz.
- İzlenen klasörler: bu klasörlere eklenen yeni GPX/FIT/TCX/KML dosyaları kendiliğinden
  kütüphaneye girer.
- Liste aya ya da yıla göre gruplanır; grupların toplamları görünür.
- Her kaydın başlangıç ve bitiş yeri ("Kadıköy → Beşiktaş") çevrimdışı
  bulunur. Yer adları GeoNames verisinden gelir; Türkiye'deki yaklaşık 920
  yer adının Türkçe yazımı (ş, ç, ğ, ı, ö, ü) uygulamada bir tabloyla
  düzeltilir, tabloda olmayan küçük yerlerde harfler eksik kalabilir.
- Etiketler ve notlar; tür ve etikete göre filtreleme; arama ad, yer, etiket ve
  notta yapılır. Çoklu seçimde toplu etiketleme.
- `gg.aa.yyyy` biçiminde tarih filtresi (yazarak ya da takvimden), hazır
  aralıklar (bugün, bu hafta, bu ay, son 30 gün, bu yıl…) ve yıl/ay seçimi.
- Ctrl/⌘ ve Shift ile çoklu seçim: birleştirme, CSV'ye aktarma,
  gösterme/gizleme, kaldırma.
- Kaldırılan kayıtlar çöp kutusuna gider; hemen "Geri al" ile geri gelir,
  30 gün sonra silinir.
- Filtreler, gizlenen izler, seçim, harita konumu ve panel boyutu açılışlar
  arasında hatırlanır; *Filtreleri sıfırla* hepsini birden kaldırır.
- Binlerce kayıtlık listeler de akıcıdır (yalnızca görünen satırlar çizilir).
- Kütüphaneyi boşaltma Ayarlar'dadır ve onay ister.

**Dışa aktarma ve ayarlar**
- Yükseklik düzeltme: telefon GPS'inin gürültülü yüksekliği, ayrıntı
  panelindeki “⛰ Yüksekliği düzelt” ile arazi yüksekliğiyle (Copernicus DEM,
  Open-Meteo; internet gerekir) değiştirilir. Önceki hal saklanır, geri
  alınabilir.
- Yola oturtma: seyrek noktalı kayıtlar (Google konum geçmişi, dakikada bir
  nokta alan uygulamalar) “🛣 Yola oturt” ile OpenStreetMap yollarına
  eşleştirilir (OSRM, routing.openstreetmap.de; etkinlik türüne göre araç,
  bisiklet ya da yaya). Noktalar arası düz çizgiler izlenen yol olur; geri
  alınabilir.
- Seçili ya da filtrelenmiş kayıtlar tek dosyada birleştirilerek GPX, KML,
  TCX ya da FIT olarak dışa aktarılabilir.
- Özet tablosu CSV olarak (Türkçe Excel'in doğrudan açacağı biçimde), seçili
  kayıt GPX, KML (Google Earth), TCX ya da FIT (Garmin Connect, Strava) olarak
  kaydedilebilir. FIT, TCX ve KML dosyaları kütüphaneye GPX'e çevrilerek
  alınır.
- Ayarlar: etkinlik türüne göre hazır eşikler, duruyor sayılma hızı,
  yükseklik gürültü eşiği; saatlerin bilgisayarın ya da kaydın yapıldığı yerin
  saat dilimine göre gösterilmesi; izlenen klasörler. Hesaplama ayarı
  değişince kayıtlar yeniden hesaplanırken eski liste görünür kalır ve
  ilerleme haritada gösterilir.

**Açma yolları ve klavye**
- Sürükle-bırak, *Dosya Aç…* (Ctrl/⌘+O), *Klasör Aç…* (Ctrl/⌘+Shift+O),
  `.gpx`, `.fit`, `.tcx`, `.kml` dosyalarına çift tıklama.
- ↑/↓ listede gezinir, Boşluk oynatır/durdurur, Esc seçimi kaldırır,
  Ctrl/⌘+0 tüm kayıtlara yakınlaştırır, Ctrl/⌘+B kenar çubuğu,
  Ctrl/⌘+Shift+H ısı haritası, Ctrl/⌘+I özet, Ctrl/⌘+E CSV, Ctrl/⌘+Shift+E
  PNG, Ctrl/⌘+S farklı kaydet, Ctrl/⌘+, ayarlar. Tüm kısayollar ve fare
  hareketleri uygulamada *?* düğmesiyle (ya da ? tuşuyla) görülür.

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

Gereksinimler: [Rust](https://rustup.rs), Node.js 22.12+ ve
[Tauri ön koşulları](https://tauri.app/start/prerequisites/)
(Windows'ta WebView2 ve MSVC Build Tools, macOS'ta Xcode Command Line Tools).

```sh
npm install
npm run tauri dev      # geliştirme modunda çalıştır
npm run tauri build    # bu işletim sistemi için kurulum dosyası üret
cargo test -p gpx-core -p gpxer # çekirdek ve uygulama testleri
npm test               # arayüz birim testleri (Vitest, src/**/*.test.ts)
```

CI'daki *Testler* işi ayrıca `cargo fmt --all --check` ve
`cargo clippy --workspace --all-targets -- -D warnings` çalıştırır; push'lamadan
önce bunları da yerelde denemek iyi olur.

Yayımlanan sürümler yalnızca Windows x64 ve macOS Apple Silicon (arm64) için
derlenir; Linux ve Intel Mac paketi yoktur (kaynaktan derlenebilir).

Ölçüm/deneme aracı:

```sh
cargo run --release -p gpx-core --example dump -- ozet.json klasor/*.gpx
```

## Proje yapısı

```
crates/gpx-core/   GPX/FIT/TCX/KML okuma ve yazma, istatistik, sıçrama temizleme,
                   duraklar, tür tahmini, sadeleştirme, kırpma/bölme/birleştirme
src-tauri/         Masaüstü uygulaması: komutlar (lib.rs), kütüphane ve önbellek (library.rs),
                   yer adları (geo.rs), dışa aktarma (export.rs), kırp/böl/birleştir
                   (edit.rs), fotoğraflar, menü, ayarlar ve klasör izleme
src/               React arayüzü
  components/      Görünümler (liste, kayıt paneli, grafik, özet, pencereler)
  hooks/           Uygulama durumu: yükleme, filtreler, dışa aktarma, klavye…
  map/             Harita katmanları, GeoJSON, açılır pencereler, altlıklar
  lib/, *.ts       Saf mantık (günler, uçuşlar, çakışmalar, güzergâhlar,
                   fotoğraflar, biçimlendirme); *.test.ts birim testleri
assets/icon.svg    Uygulama simgesi kaynağı (`npx tauri icon assets/icon.png`)
```

Harita altlıkları © OpenStreetMap katkıcıları, OpenFreeMap (OpenMapTiles), OpenTopoMap ve Esri'dir. Sade ve Koyu altlıklar vektördür; her yakınlaşmada keskin kalır (OpenFreeMap erişilemezse Esri raster altlığa dönülür).
İnternet bağlantısı olmadan rotalar yine çizilir, yalnızca altlık görünmez.
