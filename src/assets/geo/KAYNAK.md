# Sınır verileri

- `ulkeler.geojson`: Natural Earth 1:50m ülke sınırları (kamu malı), world-atlas
  2.0.2 paketinden (ISC) GeoJSON'a çevrildi; `cc` ISO 3166-1 alfa-2 kodu.
  Koordinatlar 0,001°'ye yuvarlandı.
- `tr-iller.geojson`: Türkiye il sınırları, cihadturhan/tr-geojson
  (© OpenStreetMap katkıcıları, ODbL). Koordinatlar 0,001°'ye yuvarlandı.
- `bolgeler.geojson`: Türkiye dışındaki ülkelerin birinci düzey idari bölgeleri
  (eyalet, bölge, il…), Natural Earth 1:10m admin-1 (kamu malı). mapshaper ile
  %10'a sadeleştirildi, koordinatlar 0,001°'ye yuvarlandı; `name` Türkçe ad
  ("ili", "eyaleti" gibi ekler atıldı), `en` İngilizce ad, `cc` ISO alfa-2.
