# GPXer

Windows ve macOS'ta çalışan, yüzlerce GPX günlüğünü aynı anda rahatça açabilen
bir GPX görüntüleyici. [Tauri 2](https://tauri.app) (Rust) + React + MapLibre GL
ile yazılmıştır.

## Özellikler

- **Harita:** iz (track), rota (route) ve işaret noktaları (waypoint); sokak,
  topoğrafik ve uydu altlıkları. Rotaya tıklayınca seçilir, üzerine gelince adı
  ve tarihi görünür.
- **İstatistikler:** mesafe, toplam/hareket süresi, ortalama ve maksimum hız,
  tempo, toplam tırmanış/iniş, en düşük/en yüksek nokta.
- **Yükseklik grafiği:** mesafeye göre profil, isteğe bağlı hız eğrisi. Grafikte
  gezinince haritada konum işaretlenir; sürükleyerek yakınlaştırılır.
- **Çoklu dosya:** her dosya ayrı renkte; arama, tarih aralığı filtresi,
  sıralama, tek tek ya da toplu gizleme; filtrelenen dosyaların toplamları.
- **Açma yolları:** sürükle-bırak (dosya ya da klasör), *Dosya → Dosya Aç…*
  (Ctrl/⌘+O), *Klasör Aç…* (Ctrl/⌘+Shift+O, alt klasörler dahil taranır) ve
  `.gpx` dosyalarına çift tıklama. Uygulama açıkken çift tıklanan dosya mevcut
  pencereye eklenir.
- **Klavye:** ↑/↓ listede gezinir, Esc seçimi kaldırır, Ctrl/⌘+0 tümünü
  gösterir, Ctrl/⌘+B kenar çubuğunu açıp kapatır. Listede çift tıklama o rotaya
  yakınlaştırır.

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
Apple Silicon + Intel universal) kurulum dosyalarını üretir. Bunları
**Actions → Derleme → ilgili çalıştırma → Artifacts** bölümünden
indirebilirsiniz.

## Yeni sürüm yayımlamak

1. `package.json`, `src-tauri/Cargo.toml` ve `src-tauri/tauri.conf.json`
   içindeki sürümü artırın (ör. `0.2.1`).
2. `v0.2.1` etiketini push'layın. Derleme bitince GitHub sürümü yayımlanır.
3. Kurulu uygulamalar açılışta yeni sürümü bulup güncellemeyi önerir
   (ya da menüden *Güncellemeleri Denetle…*).

Güncellemeler imzalıdır. Repo ayarlarında `TAURI_SIGNING_PRIVATE_KEY` ve
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` gizli değerleri tanımlı olmalıdır;
açık anahtar `tauri.conf.json` içindedir.

Uygulama henüz kod imzalı değil:

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
cargo test -p gpx-core # çekirdek testleri
```

Ölçüm/deneme aracı:

```sh
cargo run --release -p gpx-core --example dump -- ozet.json klasor/*.gpx
```

## Proje yapısı

```
crates/gpx-core/   GPX ayrıştırma, istatistik, sadeleştirme (Tauri'den bağımsız, testli)
src-tauri/         Masaüstü uygulaması: komutlar, menü, dosya ilişkilendirme
src/               React arayüzü (harita, liste, grafik)
assets/icon.svg    Uygulama simgesi kaynağı (`npx tauri icon assets/icon.png`)
```

Harita altlıkları © OpenStreetMap katkıcıları, OpenTopoMap ve Esri'dir.
İnternet bağlantısı olmadan rotalar yine çizilir, yalnızca altlık görünmez.
