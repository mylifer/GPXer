//! Haritada yer arama: çevrimdışı yerleşim listesi (GeoNames, ~145 bin yer)
//! ve isteğe bağlı çevrimiçi arama (Photon, OpenStreetMap verisi).

use crate::run_blocking;
use serde::Serialize;
use std::io::Read;
use std::sync::OnceLock;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaceHit {
    pub(crate) name: String,
    /// İl/eyalet, ülke gibi ayırt edici bilgi.
    pub(crate) detail: String,
    pub(crate) lat: f64,
    pub(crate) lon: f64,
    /// Kapsayan kutu [batı, güney, doğu, kuzey]; varsa haritada bu kutu gösterilir.
    pub(crate) bbox: Option<[f64; 4]>,
    /// "city" (çevrimdışı) ya da OSM türü (ör. "street", "country").
    pub(crate) kind: String,
}

impl PlaceHit {
    pub(crate) fn new(
        name: String,
        detail: String,
        lat: f64,
        lon: f64,
        bbox: Option<[f64; 4]>,
        kind: String,
    ) -> Self {
        PlaceHit {
            name,
            detail,
            lat,
            lon,
            bbox,
            kind,
        }
    }
}

struct City {
    lat: f64,
    lon: f64,
    name: String,
    admin1: String,
    cc: String,
    key: String,
    /// GeoNames nüfusu (bilinmiyorsa 0).
    pop: u32,
}

/// Arama için sadeleştirilmiş yazım: küçük harf, aksansız (İstanbul ≈ istanbul ≈ Istanbul).
pub(crate) fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
            'ç' | 'ć' | 'č' => 'c',
            'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ę' | 'ě' => 'e',
            'ì' | 'í' | 'î' | 'ï' | 'ı' | 'ī' => 'i',
            'ñ' | 'ń' | 'ň' => 'n',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
            'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' => 'u',
            'ý' | 'ÿ' => 'y',
            'ğ' => 'g',
            'ş' | 'ś' | 'š' | 'ș' => 's',
            'ž' | 'ź' | 'ż' => 'z',
            'ł' => 'l',
            'ř' => 'r',
            'ț' => 't',
            // "i̇" (İ'nin küçük hali) birleşik nokta bırakır.
            '\u{307}' => '\0',
            c => c,
        })
        .filter(|&c| c != '\0')
        .collect()
}

fn cities() -> &'static [City] {
    static CITIES: OnceLock<Vec<City>> = OnceLock::new();
    CITIES.get_or_init(|| {
        let mut text = String::new();
        let _ = flate2::read::GzDecoder::new(&include_bytes!("cities.tsv.gz")[..])
            .read_to_string(&mut text);
        text.lines()
            .filter_map(|l| {
                let mut f = l.split('\t');
                let lat = f.next()?.parse().ok()?;
                let lon = f.next()?.parse().ok()?;
                let raw = f.next()?;
                let admin1 = f.next()?.to_owned();
                let cc = f.next()?.to_owned();
                let pop = f.next().and_then(|p| p.parse().ok()).unwrap_or(0);
                // Özgün (aksanlı) yazım: "Kaş", "Göreme", "Zürich".
                let utf = f.next().filter(|u| !u.is_empty());
                let admin1 = if cc == "TR" {
                    crate::geo::turkish(&admin1)
                } else {
                    admin1
                };
                let name = match utf {
                    Some(u) => u.to_owned(),
                    None if cc == "TR" => crate::geo::turkish(raw),
                    None => raw.to_owned(),
                };
                // Türkçe yazımla da, özgün yazımla da bulunsun.
                let key = format!("{}|{}", fold(&name), fold(raw));
                Some(City {
                    lat,
                    lon,
                    name,
                    admin1,
                    cc,
                    key,
                    pop,
                })
            })
            .collect()
    })
}

/// Çevrimdışı yerleşim araması. `prefer`: öne alınacak ülke kodları (ör. gezilen ülkeler).
pub(crate) fn search_cities(query: &str, prefer: &[String], limit: usize) -> Vec<PlaceHit> {
    let q = fold(query.trim());
    if q.chars().count() < 2 {
        return Vec::new();
    }
    // (eşleşme sırası, önem, yer): önem nüfusun logaritması; Türkiye ve
    // gezilen ülkeler öne alınır (aynı adlı küçük yer büyük şehri geçmesin
    // diye nüfus yine sayılır: "Paris" Fransa'daki, "Kemer" Antalya'daki).
    let mut hits: Vec<(u8, f64, &City)> = Vec::new();
    for c in cities() {
        let rank = c
            .key
            .split('|')
            .filter_map(|k| {
                if k == q {
                    Some(0)
                } else if k.starts_with(&q) {
                    Some(1)
                } else if k.split([' ', '-', '\'']).any(|w| w.starts_with(&q)) {
                    Some(2)
                } else {
                    None
                }
            })
            .min();
        if let Some(r) = rank {
            let boost = if c.cc == "TR" {
                2.0
            } else if prefer.contains(&c.cc) {
                1.0
            } else {
                0.0
            };
            hits.push((
                r,
                f64::from(c.pop).ln_1p() / std::f64::consts::LN_10 + boost,
                c,
            ));
        }
    }
    hits.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(b.1.total_cmp(&a.1))
            .then_with(|| a.2.name.len().cmp(&b.2.name.len()))
            .then_with(|| a.2.name.cmp(&b.2.name))
    });
    hits.into_iter()
        .take(limit)
        .map(|(_, _, c)| PlaceHit {
            name: c.name.clone(),
            detail: [c.admin1.as_str(), c.cc.as_str()]
                .iter()
                .filter(|s| !s.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join(", "),
            lat: c.lat,
            lon: c.lon,
            bbox: None,
            kind: "city".into(),
        })
        .collect()
}

/// Photon yanıtını sonuçlara çevirir.
fn parse_photon(v: &serde_json::Value) -> Vec<PlaceHit> {
    let Some(features) = v["features"].as_array() else {
        return Vec::new();
    };
    features
        .iter()
        .filter_map(|f| {
            let c = f["geometry"]["coordinates"].as_array()?;
            let (lon, lat) = (c.first()?.as_f64()?, c.get(1)?.as_f64()?);
            let p = &f["properties"];
            let s = |k: &str| p[k].as_str().unwrap_or("").to_owned();
            let street = [s("street"), s("housenumber")].join(" ").trim().to_owned();
            let name = [s("name"), street.clone()]
                .into_iter()
                .find(|x| !x.is_empty())?;
            let mut parts: Vec<String> = Vec::new();
            for k in [
                if s("name").is_empty() {
                    String::new()
                } else {
                    street
                },
                s("district"),
                s("city"),
                s("state"),
                s("country"),
            ] {
                if !k.is_empty() && k != name && !parts.contains(&k) {
                    parts.push(k);
                }
            }
            // Photon kutusu: [batı, kuzey, doğu, güney].
            let bbox = p["extent"].as_array().and_then(|e| {
                let n: Vec<f64> = e.iter().filter_map(|x| x.as_f64()).collect();
                (n.len() == 4).then(|| [n[0], n[3], n[2], n[1]])
            });
            Some(PlaceHit {
                name,
                detail: parts.join(", "),
                lat,
                lon,
                bbox,
                kind: s("osm_value"),
            })
        })
        .collect()
}

#[tauri::command]
pub(crate) async fn search_places_offline(
    query: String,
    prefer: Vec<String>,
) -> Result<Vec<PlaceHit>, String> {
    run_blocking(move || search_cities(&query, &prefer, 8)).await
}

/// Türkçe adres kısaltmalarının açılımı (sorgu kelimesi → aranacak kelime):
/// "Atatürk cd" → "Atatürk Caddesi", "1234 sk" → "1234 Sokak".
pub(crate) fn expand_word(w: &str) -> Option<&'static str> {
    Some(match fold(w.trim_end_matches('.')).as_str() {
        "cd" | "cad" | "cadd" => "Caddesi",
        "sk" | "sok" | "sokk" => "Sokak",
        "blv" | "bulv" | "bul" => "Bulvarı",
        "mh" | "mah" | "mahl" => "Mahallesi",
        "sb" | "sit" => "Sitesi",
        _ => return None,
    })
}

/// Sorgudaki kısaltmalar açılmış hali.
pub(crate) fn expand_query(q: &str) -> String {
    q.split_whitespace()
        .map(|w| expand_word(w).unwrap_or(w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Sonuç adı sorgunun bütün kelimelerini (kelime başı olarak) içeriyor mu.
fn name_fits(name: &str, query: &str) -> bool {
    let key = fold(name);
    let words: Vec<&str> = key.split([' ', '-', '.', ',', '\'']).collect();
    fold(query).split_whitespace().all(|w| {
        words
            .iter()
            .any(|k| k.starts_with(w) || (w.starts_with("sokak") && k.starts_with("soka")))
    })
}

/// Nominatim yanıtını sonuçlara çevirir.
fn parse_nominatim(v: &serde_json::Value) -> Vec<PlaceHit> {
    let Some(items) = v.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|it| {
            let num = |k: &str| it[k].as_str().and_then(|x| x.parse::<f64>().ok());
            let (lat, lon) = (num("lat")?, num("lon")?);
            let a = &it["address"];
            let s = |k: &str| a[k].as_str().unwrap_or("").to_owned();
            let name = it["name"]
                .as_str()
                .filter(|n| !n.is_empty())
                .map(str::to_owned)
                .or_else(|| {
                    it["display_name"]
                        .as_str()
                        .and_then(|d| d.split(", ").next())
                        .map(str::to_owned)
                })?;
            let mut parts: Vec<String> = Vec::new();
            for k in [
                s("road"),
                s("suburb"),
                s("town"),
                s("city"),
                s("province"),
                s("state"),
                s("country"),
            ] {
                if !k.is_empty() && k != name && !parts.contains(&k) {
                    parts.push(k);
                }
            }
            // Nominatim kutusu: [güney, kuzey, batı, doğu].
            let bbox = it["boundingbox"].as_array().and_then(|b| {
                let n: Vec<f64> = b
                    .iter()
                    .filter_map(|x| x.as_str().and_then(|x| x.parse().ok()))
                    .collect();
                (n.len() == 4).then(|| [n[2], n[0], n[3], n[1]])
            });
            let kind = it["addresstype"]
                .as_str()
                .filter(|t| *t != "road")
                .or(it["type"].as_str())
                .unwrap_or("")
                .to_owned();
            Some(PlaceHit {
                name,
                detail: parts.join(", "),
                lat,
                lon,
                bbox,
                kind,
            })
        })
        .collect()
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!(
            "GPXer/",
            env!("CARGO_PKG_VERSION"),
            " (https://github.com/mylifer/gpxer)"
        ))
        .build()
}

fn get_json(req: ureq::Request) -> Result<serde_json::Value, String> {
    let body = req
        .call()
        .map_err(|e| format!("Çevrimiçi arama yapılamadı: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Photon araması; haritanın ortası verilirse yakın sonuçlar belirgin biçimde
/// öne alınır (aynı adlı cadde her şehirde var).
fn photon(query: &str, at: Option<(f64, f64)>) -> Result<Vec<PlaceHit>, String> {
    let base = |strong: bool| {
        let mut req = agent()
            .get("https://photon.komoot.io/api/")
            .query("q", query)
            .query("limit", "12");
        if let Some((lat, lon)) = at {
            req = req
                .query("lat", &format!("{lat:.4}"))
                .query("lon", &format!("{lon:.4}"));
            if strong {
                req = req.query("location_bias_scale", "0.1").query("zoom", "12");
            }
        }
        req
    };
    // Eski sürüm sunucu ek parametreleri tanımazsa yalın istek.
    match get_json(base(true)) {
        Ok(v) => Ok(parse_photon(&v)),
        Err(_) if at.is_some() => get_json(base(false)).map(|v| parse_photon(&v)),
        Err(e) => Err(e),
    }
}

/// Nominatim araması (Photon'un bulamadığı adresler için); haritanın
/// çevresi öne alınır ama dışı da aranır.
fn nominatim(query: &str, at: Option<(f64, f64)>) -> Result<Vec<PlaceHit>, String> {
    let mut req = agent()
        .get("https://nominatim.openstreetmap.org/search")
        .query("q", query)
        .query("format", "jsonv2")
        .query("limit", "8")
        .query("addressdetails", "1")
        .query("accept-language", "tr,en");
    if let Some((lat, lon)) = at {
        let vb = format!(
            "{:.3},{:.3},{:.3},{:.3}",
            lon - 0.6,
            lat + 0.4,
            lon + 0.6,
            lat - 0.4
        );
        req = req.query("viewbox", &vb);
    }
    get_json(req).map(|v| parse_nominatim(&v))
}

#[tauri::command]
pub(crate) async fn search_places_online(
    query: String,
    lat: Option<f64>,
    lon: Option<f64>,
) -> Result<Vec<PlaceHit>, String> {
    if query.trim().chars().count() < 3 {
        return Ok(Vec::new());
    }
    run_blocking(move || {
        let q = expand_query(query.trim());
        let at = lat.zip(lon);
        let first = photon(&q, at);
        // Photon'da sorguya uyan ad yoksa (ya da Photon'a ulaşılamadıysa) Nominatim.
        let good = first
            .as_ref()
            .is_ok_and(|r| r.iter().any(|h| name_fits(&h.name, &q)));
        if good {
            return first;
        }
        match (first, nominatim(&q, at)) {
            (Ok(mut a), Ok(b)) => {
                // Nominatim'in uyan sonuçları önce.
                let mut out: Vec<PlaceHit> =
                    b.into_iter().filter(|h| name_fits(&h.name, &q)).collect();
                out.append(&mut a);
                Ok(out)
            }
            (Ok(a), Err(_)) => Ok(a),
            (Err(_), Ok(b)) => Ok(b),
            (Err(e), Err(_)) => Err(e),
        }
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_turkish_and_accents() {
        assert_eq!(fold("İstanbul"), "istanbul");
        assert_eq!(fold("Çanakkale Şile Ağrı"), "canakkale sile agri");
        assert_eq!(fold("Zürich"), "zurich");
    }

    #[test]
    fn finds_cities_offline() {
        let r = search_cities("eskisehir", &[], 5);
        assert_eq!(r[0].name, "Eskişehir");
        assert!(r[0].detail.ends_with("TR"));
        let r = search_cities("Kadıköy", &[], 5);
        assert!(r.iter().any(|h| h.name == "Kadıköy"), "{r:?}");
        // Türkiye dışı: öne alınan ülke önce.
        let r = search_cities("paris", &["FR".into()], 5);
        assert_eq!(r[0].detail.rsplit(", ").next(), Some("FR"));
        // Aynı adlı yerlerden büyüğü önce; gezilen ülke olmasa da.
        let r = search_cities("paris", &[], 5);
        assert_eq!(r[0].detail.rsplit(", ").next(), Some("FR"));
        let r = search_cities("kemer", &[], 5);
        assert!(r[0].detail.starts_with("Antalya"), "{r:?}");
        // Özgün yazım ve aksansız yazım aynı yeri bulur.
        assert_eq!(search_cities("kas", &[], 1)[0].name, "Kaş");
        assert_eq!(search_cities("Göreme", &[], 1)[0].name, "Göreme");
        assert!(search_cities("x", &[], 5).is_empty());
    }

    #[test]
    fn parses_photon() {
        let v = serde_json::json!({"features":[
            {"geometry":{"coordinates":[29.03,40.99]},"properties":{"name":"Moda","city":"Kadıköy","state":"İstanbul","country":"Türkiye","osm_value":"suburb","extent":[29.0,41.0,29.1,40.9]}},
            {"geometry":{"coordinates":[29.0,41.0]},"properties":{"street":"Bağdat Caddesi","housenumber":"5","city":"İstanbul","country":"Türkiye","osm_value":"house"}}
        ]});
        let r = parse_photon(&v);
        assert_eq!(r[0].name, "Moda");
        assert_eq!(r[0].detail, "Kadıköy, İstanbul, Türkiye");
        assert_eq!(r[0].bbox, Some([29.0, 40.9, 29.1, 41.0]));
        assert_eq!(r[1].name, "Bağdat Caddesi 5");
        assert_eq!(r[1].detail, "İstanbul, Türkiye");
    }

    #[test]
    fn expands_turkish_abbreviations() {
        assert_eq!(expand_query("Atatürk cd."), "Atatürk Caddesi");
        assert_eq!(expand_query("1234 sk"), "1234 Sokak");
        assert_eq!(expand_query("Kordon blv izmir"), "Kordon Bulvarı izmir");
        assert_eq!(expand_query("Cadde bostan"), "Cadde bostan");
        assert!(name_fits("Atatürk Caddesi", "ataturk cadd"));
        assert!(name_fits("1234. Sokak", "1234 sok"));
        assert!(name_fits("Gül Sokağı", "gül sokak"));
        assert!(!name_fits("Atatürk Bulvarı", "ataturk caddesi"));
    }

    #[test]
    fn parses_nominatim() {
        let v = serde_json::json!([
            {"lat":"38.4237","lon":"27.1428","name":"Kıbrıs Şehitleri Caddesi","addresstype":"road","type":"tertiary",
             "boundingbox":["38.42","38.43","27.13","27.15"],
             "address":{"road":"Kıbrıs Şehitleri Caddesi","suburb":"Alsancak","city":"Konak","province":"İzmir","country":"Türkiye"}}
        ]);
        let r = parse_nominatim(&v);
        assert_eq!(r[0].name, "Kıbrıs Şehitleri Caddesi");
        assert_eq!(r[0].detail, "Alsancak, Konak, İzmir, Türkiye");
        assert_eq!(r[0].bbox, Some([27.13, 38.42, 27.15, 38.43]));
        assert_eq!(r[0].kind, "tertiary");
    }
}
