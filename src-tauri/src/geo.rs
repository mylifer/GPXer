//! Konumdan çevrimdışı coğrafi bilgiler: saat dilimi, en yakın yerleşim yeri
//! ve kaydın saat saat geçtiği yerler.

use std::collections::HashMap;
use std::sync::OnceLock;

/// Konumdan IANA saat dilimi adı (çevrimdışı veriyle).
pub(crate) fn time_zone_at(lon: f64, lat: f64) -> Option<String> {
    static FINDER: OnceLock<tzf_rs::DefaultFinder> = OnceLock::new();
    let name = FINDER
        .get_or_init(tzf_rs::DefaultFinder::new)
        .get_tz_name(lon, lat);
    (!name.is_empty()).then(|| name.to_owned())
}

/// Konuma en yakın yerleşim yerinin adı (GeoNames, çevrimdışı). 25 km'den
/// uzaktaki yerler (deniz, ıssız alan) ad vermez.
pub(crate) fn place_at(lon: f64, lat: f64) -> Option<String> {
    place_info(lon, lat).map(|(_, name)| name)
}

/// Konuma en yakın yerleşim yerinin ülke kodu ve (Türkiye'deyse Türkçe
/// yazımlı) adı; 25 km'den uzaktaysa `None`.
pub fn place_info(lon: f64, lat: f64) -> Option<(String, String)> {
    static GEO: OnceLock<reverse_geocoder::ReverseGeocoder> = OnceLock::new();
    let r = GEO
        .get_or_init(reverse_geocoder::ReverseGeocoder::new)
        .search((lat, lon))
        .record;
    let near = gpx_core::haversine_m(
        &gpx_core::parse::Point {
            lat,
            lon,
            ..Default::default()
        },
        &gpx_core::parse::Point {
            lat: r.lat,
            lon: r.lon,
            ..Default::default()
        },
    );
    if near > 25_000.0 {
        return None;
    }
    // En yakın yerleşim sınırın öte yanında olabilir (Kaş'ta en yakın yer
    // 2 km açıktaki Meis Adası). Nokta ile yerleşim farklı saat dilimlerindeyse
    // yerleşim kabul edilmez.
    if let (Some(here), Some(there)) = (time_zone_at(lon, lat), time_zone_at(r.lon, r.lat)) {
        if here != there {
            return None;
        }
    }
    let name = if r.cc == "TR" {
        turkish(&r.name)
    } else {
        r.name.clone()
    };
    Some((r.cc.clone(), name))
}

/// Saat saat geçilen yerler: her saatin ilk noktasının yeri, yalnızca bir
/// öncekinden farklıysa (ardışık aynı yerler tek girdi). Yeri bulunamayan
/// (25 km'den uzak) saatler atlanır.
pub(crate) fn visits(gpx: &gpx_core::parse::Gpx, hours: &[[f64; 3]]) -> Vec<(i64, String, String)> {
    let per_hour: Vec<(i64, String, String)> = gpx_core::hour_first_points(gpx, hours)
        .into_iter()
        .filter_map(|(hour, [lon, lat])| place_info(lon, lat).map(|(cc, n)| (hour, cc, n)))
        .collect();
    let per_hour = drop_brief_countries(per_hour);
    let mut out: Vec<(i64, String, String)> = Vec::new();
    for v in per_hour {
        if out.last().is_some_and(|(_, c, n)| *c == v.1 && *n == v.2) {
            continue;
        }
        out.push(v);
    }
    out
}

/// Bir ülkede toplam bu kadar saatten az kayıt varsa ve bu saatler kaydın
/// başında ya da sonunda değil başka ülkelerin arasında kalıyorsa (sınır
/// yakınında tek bir nokta, en yakın şehrin komşu ülkede kalması) sayılmaz.
const MIN_COUNTRY_HOURS: usize = 2;

/// Tek ülkeli kayıtta hiçbir saat atılmaz. Kayıt yeni bir ülkede başlıyor ya
/// da bitiyorsa (bir saat sonra sınırı geçip biten yolculuk) o ülke kısa da
/// olsa sayılır.
fn drop_brief_countries(per_hour: Vec<(i64, String, String)>) -> Vec<(i64, String, String)> {
    let mut totals: HashMap<&str, usize> = HashMap::new();
    for v in &per_hour {
        *totals.entry(v.1.as_str()).or_default() += 1;
    }
    if totals.len() <= 1 {
        return per_hour;
    }
    let brief: Vec<bool> = per_hour
        .iter()
        .map(|v| totals[v.1.as_str()] < MIN_COUNTRY_HOURS)
        .collect();
    let first_cc = per_hour.first().map(|v| v.1.clone());
    let last_cc = per_hour.last().map(|v| v.1.clone());
    // Kaydın ilk ve son ülke dizisi (run) atılmaz; aradakiler başka
    // ülkelerin arasında kalmıştır.
    let first_run_end = per_hour
        .iter()
        .position(|v| Some(&v.1) != first_cc.as_ref())
        .unwrap_or(per_hour.len());
    let last_run_start = per_hour
        .iter()
        .rposition(|v| Some(&v.1) != last_cc.as_ref())
        .map_or(0, |i| i + 1);
    per_hour
        .into_iter()
        .enumerate()
        .filter(|&(i, _)| !brief[i] || i < first_run_end || i >= last_run_start)
        .map(|(_, v)| v)
        .collect()
}

/// Zaman bilgisi olmayan (saatlik özeti boş) kayıtların geçtiği yerler:
/// başlangıç ve bitiş noktasının yeri, başlangıç zamanının saat başıyla (o da
/// yoksa 0).
pub(crate) fn untimed_visits(
    start: Option<[f64; 2]>,
    end: Option<[f64; 2]>,
    start_time: Option<i64>,
) -> Vec<(i64, String, String)> {
    const HOUR_MS: i64 = 3_600_000;
    let hour = start_time.map_or(0, |t| t.div_euclid(HOUR_MS) * HOUR_MS);
    let mut out: Vec<(i64, String, String)> = Vec::new();
    for [lon, lat] in [start, end].into_iter().flatten() {
        if let Some((cc, name)) = place_info(lon, lat) {
            if !out.iter().any(|(_, c, n)| *c == cc && *n == name) {
                out.push((hour, cc, name));
            }
        }
    }
    out
}

/// Veri kümesindeki Türkiye yer adları ASCII'ye çevrilmiş ("Kadikoy",
/// "UEskuedar"). Bilinen adlar tablodan Türkçe yazımlarıyla gelir; tabloda
/// olmayanlarda en azından Almanca tarzı ü/ö (ue/oe) geri getirilir.
pub(crate) fn turkish(name: &str) -> String {
    static TABLE: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    let table = TABLE.get_or_init(|| {
        include_str!("tr_places.tsv")
            .lines()
            .filter(|l| !l.starts_with('#'))
            .filter_map(|l| l.split_once('\t'))
            .collect()
    });
    if let Some(t) = table.get(name) {
        return (*t).to_owned();
    }
    name.replace("UE", "Ü")
        .replace("Ue", "Ü")
        .replace("ue", "ü")
        .replace("OE", "Ö")
        .replace("Oe", "Ö")
        .replace("oe", "ö")
}

#[cfg(test)]
mod tests;
