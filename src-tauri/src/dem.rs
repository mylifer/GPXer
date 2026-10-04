//! Arazi yüksekliğiyle yükseklik düzeltme: telefon GPS'inin gürültülü
//! yüksekliği (tırmanışı şişiriyor) Copernicus DEM (90 m) değerleriyle
//! değiştirilir. Değerler Open-Meteo'nun ücretsiz yükseklik servisinden gelir
//! (anahtar gerektirmez); düzeltme kütüphanedeki kopyaya yazılır, önceki hali
//! çöp kutusunda saklanır ve geri alınabilir.

use crate::library::{Library, LoadResult};
use crate::meta::MetaStore;
use crate::run_blocking;
use crate::settings::SettingsStore;
use serde::Serialize;
use tauri::{AppHandle, Manager};

const API: &str = "https://api.open-meteo.com/v1/elevation";
/// Servisin bir istekte kabul ettiği en çok konum.
const BATCH: usize = 100;

/// Konumların arazi yüksekliği (`base` sınamada yerel sunucu olabilir).
pub(crate) fn fetch(base: &str, coords: &[(f64, f64)]) -> Result<Vec<Option<f64>>, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(30))
        .build();
    let mut out = Vec::with_capacity(coords.len());
    for chunk in coords.chunks(BATCH) {
        let lat: Vec<String> = chunk.iter().map(|c| format!("{:.6}", c.0)).collect();
        let lon: Vec<String> = chunk.iter().map(|c| format!("{:.6}", c.1)).collect();
        let resp = agent
            .get(base)
            .query("latitude", &lat.join(","))
            .query("longitude", &lon.join(","))
            .call()
            .map_err(|e| match e {
                ureq::Error::Status(429, _) => {
                    "Yükseklik servisi şu an çok yoğun; biraz sonra yeniden deneyin".to_string()
                }
                ureq::Error::Status(code, _) => format!("Yükseklik servisi hata verdi ({code})"),
                ureq::Error::Transport(t) => {
                    format!("Yükseklik servisine ulaşılamadı (internet bağlantısı?): {t}")
                }
            })?;
        let v: serde_json::Value = serde_json::from_reader(resp.into_reader())
            .map_err(|e| format!("Yükseklik yanıtı okunamadı: {e}"))?;
        let arr = v["elevation"]
            .as_array()
            .ok_or("Yükseklik yanıtı beklenmeyen biçimde")?;
        if arr.len() != chunk.len() {
            return Err("Yükseklik yanıtı eksik".into());
        }
        out.extend(arr.iter().map(|x| x.as_f64()));
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FixResult {
    result: LoadResult,
    /// Geri almak için saklanan önceki hal.
    previous: String,
    gain_before: Option<f64>,
}

/// Kaydın yüksekliklerini arazi yüksekliğiyle değiştirir.
#[tauri::command]
pub(crate) async fn fix_elevation(app: AppHandle, path: String) -> Result<FixResult, String> {
    run_blocking(move || {
        let library = app.state::<Library>();
        library.check(&path)?;
        let cfg = app.state::<SettingsStore>().stats();
        let chosen = app.state::<MetaStore>().activity(&path);
        let gain_before = library
            .summarize(&path, &cfg, chosen)
            .ok()
            .and_then(|(s, _)| s.stats.elevation_gain_m);
        let (mut gpx, _) = gpx_core::read_gpx_file(path.as_ref()).map_err(|e| e.to_string())?;
        let n = gpx_core::dem::apply_dem(&mut gpx, |c| fetch(API, c))?;
        if n == 0 {
            return Err("Bu kaydın konumları için arazi yüksekliği bulunamadı".into());
        }
        let previous = library.keep_previous(&path)?;
        let text = gpx_core::write::write_gpx(&gpx);
        if let Err(e) = crate::store::write_atomic(path.as_ref(), text.as_bytes()) {
            let _ = std::fs::remove_file(&previous);
            return Err(format!("Kayıt yazılamadı: {e}"));
        }
        let result = library.load(path, &cfg, chosen);
        let _ = library.flush_cache();
        Ok(FixResult {
            result,
            previous,
            gain_before,
        })
    })
    .await?
}

/// [`fix_elevation`]'ı geri alır.
#[tauri::command]
pub(crate) async fn undo_fix_elevation(
    app: AppHandle,
    path: String,
    previous: String,
) -> Result<LoadResult, String> {
    run_blocking(move || {
        let library = app.state::<Library>();
        library.put_back(&path, &previous)?;
        let cfg = app.state::<SettingsStore>().stats();
        let chosen = app.state::<MetaStore>().activity(&path);
        let result = library.load(path, &cfg, chosen);
        let _ = library.flush_cache();
        Ok(result)
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};

    /// İstekteki konum sayısı kadar (enlem × 10) yükseklik veren yerel sunucu.
    fn serve(requests: usize) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(requests) {
                let mut s = stream.unwrap();
                let mut line = String::new();
                BufReader::new(&s).read_line(&mut line).unwrap();
                let q = line.split_whitespace().nth(1).unwrap_or("").to_owned();
                let lat = q
                    .split(['?', '&'])
                    .find_map(|kv| kv.strip_prefix("latitude="))
                    .unwrap_or("")
                    .replace("%2C", ",");
                let vals: Vec<String> = lat
                    .split(',')
                    .map(|x| format!("{}", x.parse::<f64>().unwrap_or(0.0) * 10.0))
                    .collect();
                let body = format!(r#"{{"elevation":[{}]}}"#, vals.join(","));
                write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        format!("http://{addr}/v1/elevation")
    }

    #[test]
    fn fetches_in_batches() {
        let base = serve(3);
        let coords: Vec<(f64, f64)> = (0..250).map(|k| (40.0 + k as f64 * 0.001, 29.0)).collect();
        let e = fetch(&base, &coords).unwrap();
        assert_eq!(e.len(), 250);
        assert!((e[0].unwrap() - 400.0).abs() < 1e-6);
        assert!((e[249].unwrap() - 402.49).abs() < 1e-3);
    }

    #[test]
    fn unreachable_service_is_reported() {
        let err = fetch("http://127.0.0.1:9/v1/elevation", &[(41.0, 29.0)]).unwrap_err();
        assert!(err.contains("ulaşılamadı"), "{err}");
    }
}
