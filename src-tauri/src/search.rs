//! Haritada yer arama: çevrimdışı yerleşim listesi (GeoNames, ~145 bin yer)
//! ve isteğe bağlı çevrimiçi arama (Photon, OpenStreetMap verisi).

use crate::run_blocking;
use serde::Serialize;
use std::io::Read;
use std::sync::OnceLock;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlaceHit {
    name: String,
    /// İl/eyalet, ülke gibi ayırt edici bilgi.
    detail: String,
    lat: f64,
    lon: f64,
    /// Kapsayan kutu [batı, güney, doğu, kuzey]; varsa haritada bu kutu gösterilir.
    bbox: Option<[f64; 4]>,
    /// "city" (çevrimdışı) ya da OSM türü (ör. "street", "country").
    kind: String,
}

struct City {
    lat: f64,
    lon: f64,
    name: String,
    admin1: String,
    cc: String,
    key: String,
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
                let admin1 = if cc == "TR" {
                    crate::geo::turkish(&admin1)
                } else {
                    admin1
                };
                let name = if cc == "TR" {
                    crate::geo::turkish(raw)
                } else {
                    raw.to_owned()
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
    let mut hits: Vec<(u8, u8, usize, &City)> = Vec::new();
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
            let country = if c.cc == "TR" {
                0
            } else if prefer.contains(&c.cc) {
                1
            } else {
                2
            };
            hits.push((r, country, c.name.len(), c));
        }
    }
    hits.sort_by(|a, b| {
        (a.0, a.1, a.2)
            .cmp(&(b.0, b.1, b.2))
            .then_with(|| a.3.name.cmp(&b.3.name))
    });
    hits.into_iter()
        .take(limit)
        .map(|(_, _, _, c)| PlaceHit {
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
        let mut req = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(10))
            .user_agent(concat!("GPXer/", env!("CARGO_PKG_VERSION")))
            .build()
            .get("https://photon.komoot.io/api/")
            .query("q", query.trim())
            .query("limit", "8");
        // Haritanın ortasına yakın sonuçlar öne çıksın.
        if let (Some(lat), Some(lon)) = (lat, lon) {
            req = req
                .query("lat", &format!("{lat:.4}"))
                .query("lon", &format!("{lon:.4}"));
        }
        let body = req
            .call()
            .map_err(|e| format!("Çevrimiçi arama yapılamadı: {e}"))?
            .into_string()
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        Ok(parse_photon(&v))
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
}
