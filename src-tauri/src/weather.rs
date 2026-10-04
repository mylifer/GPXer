//! Kaydın yapıldığı saatlerdeki hava durumu: Open-Meteo'nun ücretsiz geçmiş
//! hava arşivi (ERA5; anahtar gerektirmez). Noktalar gün gün gruplanır, her gün
//! için tek istek atılır.

use crate::run_blocking;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const API: &str = "https://archive-api.open-meteo.com/v1/archive";

#[derive(Deserialize)]
pub(crate) struct WeatherPoint {
    lat: f64,
    lon: f64,
    /// Unix ms.
    t: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WeatherSample {
    t: i64,
    temp_c: Option<f64>,
    precip_mm: Option<f64>,
    wind_kmh: Option<f64>,
    /// WMO hava kodu.
    code: Option<i64>,
}

fn day_of(t: i64) -> String {
    gpx_core::write::format_time(t)[..10].to_owned()
}

fn get(base: &str, date: &str, pts: &[&WeatherPoint]) -> Result<serde_json::Value, String> {
    let lat: Vec<String> = pts.iter().map(|p| format!("{:.3}", p.lat)).collect();
    let lon: Vec<String> = pts.iter().map(|p| format!("{:.3}", p.lon)).collect();
    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .get(base)
        .query("latitude", &lat.join(","))
        .query("longitude", &lon.join(","))
        .query("start_date", date)
        .query("end_date", date)
        .query(
            "hourly",
            "temperature_2m,precipitation,wind_speed_10m,weather_code",
        )
        .query("timezone", "GMT")
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(429, _) => {
                "Hava servisi şu an çok yoğun; biraz sonra yeniden deneyin".to_string()
            }
            ureq::Error::Status(code, _) => format!("Hava servisi hata verdi ({code})"),
            ureq::Error::Transport(t) => {
                format!("Hava servisine ulaşılamadı (internet bağlantısı?): {t}")
            }
        })?;
    serde_json::from_reader(resp.into_reader()).map_err(|e| format!("Hava yanıtı okunamadı: {e}"))
}

/// Her nokta için o saatin hava değerleri (aynı sırada).
pub(crate) fn fetch(base: &str, points: &[WeatherPoint]) -> Result<Vec<WeatherSample>, String> {
    let mut by_day: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, p) in points.iter().enumerate() {
        by_day.entry(day_of(p.t)).or_default().push(i);
    }
    let mut out: Vec<Option<WeatherSample>> = (0..points.len()).map(|_| None).collect();
    for (date, idx) in by_day {
        let pts: Vec<&WeatherPoint> = idx.iter().map(|&i| &points[i]).collect();
        let v = get(base, &date, &pts)?;
        // Tek konumda nesne, birden çokta dizi döner.
        let locs: Vec<&serde_json::Value> = match v.as_array() {
            Some(a) => a.iter().collect(),
            None => vec![&v],
        };
        for (k, &i) in idx.iter().enumerate() {
            let p = &points[i];
            let h = &locs.get(k).map(|l| &l["hourly"]);
            let hour = ((p.t.rem_euclid(86_400_000)) / 3_600_000) as usize;
            let num = |key: &str| h.and_then(|h| h[key].get(hour)).and_then(|x| x.as_f64());
            out[i] = Some(WeatherSample {
                t: p.t,
                temp_c: num("temperature_2m"),
                precip_mm: num("precipitation"),
                wind_kmh: num("wind_speed_10m"),
                code: num("weather_code").map(|c| c as i64),
            });
        }
    }
    Ok(out.into_iter().flatten().collect())
}

/// Noktaların (konum, zaman) geçmiş hava durumu.
#[tauri::command]
pub(crate) async fn weather_at(points: Vec<WeatherPoint>) -> Result<Vec<WeatherSample>, String> {
    if points.len() > 500 {
        return Err("Çok fazla nokta".into());
    }
    run_blocking(move || fetch(API, &points)).await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    #[test]
    fn groups_by_day_and_picks_the_hour() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(2) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(&s).read_line(&mut line).unwrap();
                let two = line
                    .split(['?', '&'])
                    .any(|kv| kv.starts_with("latitude=") && kv.contains("%2C"));
                let loc = |base: f64| {
                    let temps: Vec<String> =
                        (0..24).map(|h| format!("{}", base + h as f64)).collect();
                    format!(
                        r#"{{"hourly":{{"temperature_2m":[{}],"precipitation":[{}],"wind_speed_10m":[{}],"weather_code":[{}]}}}}"#,
                        temps.join(","),
                        vec!["0.5"; 24].join(","),
                        vec!["12"; 24].join(","),
                        vec!["61"; 24].join(",")
                    )
                };
                let body = if two {
                    format!("[{},{}]", loc(0.0), loc(100.0))
                } else {
                    loc(50.0)
                };
                write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let base = format!("http://{addr}/v1/archive");
        // 2023-12-10 05:30 ve 15:10 UTC (aynı gün, iki konum), 2023-12-11 09:00.
        let t0 = 1_702_166_400_000; // 2023-12-10T00:00Z
        let pts = vec![
            WeatherPoint {
                lat: 41.0,
                lon: 29.0,
                t: t0 + 5 * 3_600_000 + 1_800_000,
            },
            WeatherPoint {
                lat: 40.0,
                lon: 33.0,
                t: t0 + 15 * 3_600_000 + 600_000,
            },
            WeatherPoint {
                lat: 39.0,
                lon: 35.0,
                t: t0 + 33 * 3_600_000,
            },
        ];
        let w = fetch(&base, &pts).unwrap();
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].temp_c, Some(5.0));
        assert_eq!(w[1].temp_c, Some(115.0));
        assert_eq!(w[2].temp_c, Some(59.0));
        assert_eq!(w[2].code, Some(61));
    }
}
