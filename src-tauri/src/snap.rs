//! Seyrek kayıtları (Google konum geçmişi, dakikada bir nokta alan
//! uygulamalar) yola oturtma: noktalar OSRM harita eşleştirme servisine
//! (FOSSGIS, routing.openstreetmap.de; anahtar gerektirmez) gönderilir,
//! eşleşen yol kayda yazılır. Önceki hal saklanır, geri alınabilir.

use crate::rewrite::{rewrite_record, RewriteResult};
use crate::run_blocking;
use gpx_core::analysis::Activity;
use gpx_core::snap::Matched;
use tauri::{AppHandle, Manager};

const API: &str = "https://routing.openstreetmap.de";
/// Bir noktanın yola en çok bu kadar uzak olabileceği varsayılır (m).
const RADIUS_M: u32 = 50;
/// Bu kadar sık noktalı kayıt zaten yolu izliyor (ortanca adım, m).
const DENSE_STEP_M: f64 = 40.0;
/// Servise yük olmasın: bu kadardan fazla parça (×100 nokta) gönderilmez.
const MAX_REQUESTS: usize = 150;

fn profile(a: Activity) -> &'static str {
    match a {
        Activity::Walk | Activity::Run => "routed-foot",
        Activity::Bike => "routed-bike",
        _ => "routed-car",
    }
}

/// Bir parçayı eşleştirir (`base` sınamada yerel sunucu olabilir).
pub(crate) fn match_chunk(
    agent: &ureq::Agent,
    base: &str,
    profile: &str,
    pts: &[(f64, f64, Option<i64>)],
) -> Result<Matched, String> {
    let coords: Vec<String> = pts
        .iter()
        .map(|(la, lo, _)| format!("{lo:.6},{la:.6}"))
        .collect();
    let url = format!("{base}/{profile}/match/v1/driving/{}", coords.join(";"));
    let mut req = agent
        .get(&url)
        .query("geometries", "geojson")
        .query("overview", "full")
        .query("annotations", "distance")
        .query("gaps", "split")
        .query("radiuses", &vec![RADIUS_M.to_string(); pts.len()].join(";"));
    // Zamanlar artan olmalı (aynı saniyedekiler servisce reddedilir).
    let secs: Vec<i64> = pts.iter().filter_map(|p| p.2.map(|t| t / 1000)).collect();
    if secs.len() == pts.len() && secs.windows(2).all(|w| w[0] < w[1]) {
        let ts: Vec<String> = secs.iter().map(i64::to_string).collect();
        req = req.query("timestamps", &ts.join(";"));
    }
    let v: serde_json::Value = match req.call() {
        Ok(r) => serde_json::from_reader(r.into_reader())
            .map_err(|e| format!("Eşleştirme yanıtı okunamadı: {e}"))?,
        // Eşleşme yoksa servis 400 + "NoMatch" verir: o parça olduğu gibi kalır.
        Err(ureq::Error::Status(400, r)) => {
            serde_json::from_reader(r.into_reader()).unwrap_or_default()
        }
        Err(ureq::Error::Status(429, _)) => {
            return Err("Eşleştirme servisi şu an çok yoğun; biraz sonra yeniden deneyin".into())
        }
        Err(ureq::Error::Status(code, _)) => {
            return Err(format!("Eşleştirme servisi hata verdi ({code})"))
        }
        Err(ureq::Error::Transport(t)) => {
            return Err(format!(
                "Eşleştirme servisine ulaşılamadı (internet bağlantısı?): {t}"
            ))
        }
    };
    Ok(parse_match(&v, pts.len()))
}

fn lonlat(v: &serde_json::Value) -> Option<(f64, f64)> {
    Some((v[1].as_f64()?, v[0].as_f64()?))
}

/// OSRM `match` yanıtını [`Matched`]'e çevirir.
fn parse_match(v: &serde_json::Value, n: usize) -> Matched {
    let mut m = Matched {
        snapped: vec![None; n],
        legs: vec![None; n.saturating_sub(1)],
    };
    if v["code"] != "Ok" {
        return m;
    }
    let tps = v["tracepoints"].as_array().cloned().unwrap_or_default();
    // Eşleşmelerin yolları, bacaklara bölünmüş.
    let legs: Vec<Vec<Vec<(f64, f64)>>> = v["matchings"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|mt| {
            let coords: Vec<(f64, f64)> = mt["geometry"]["coordinates"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(lonlat)
                .collect();
            let mut out = Vec::new();
            let mut off = 0;
            for leg in mt["legs"].as_array().into_iter().flatten() {
                let len = leg["annotation"]["distance"].as_array().map_or(0, Vec::len);
                out.push(
                    coords
                        .get(off..=off + len)
                        .map(<[_]>::to_vec)
                        .unwrap_or_default(),
                );
                off += len;
            }
            out
        })
        .collect();
    let at = |i: usize| -> Option<(usize, usize)> {
        let t = tps.get(i)?;
        Some((
            t["matchings_index"].as_u64()? as usize,
            t["waypoint_index"].as_u64()? as usize,
        ))
    };
    for i in 0..n {
        let Some(t) = tps.get(i).filter(|t| !t.is_null()) else {
            continue;
        };
        m.snapped[i] = lonlat(&t["location"]);
        if let (Some((mi, wi)), Some((mj, wj))) = (at(i), at(i + 1)) {
            if mi == mj && wj == wi + 1 {
                m.legs[i] = legs
                    .get(mi)
                    .and_then(|l| l.get(wi))
                    .filter(|p| p.len() >= 2)
                    .cloned();
            }
        }
    }
    m
}

/// Kaydı yola oturtur.
#[tauri::command]
pub(crate) async fn snap_to_roads(app: AppHandle, path: String) -> Result<RewriteResult, String> {
    run_blocking(move || snap_with(&app, API, &path)).await?
}

fn snap_with(app: &AppHandle, base: &str, path: &str) -> Result<RewriteResult, String> {
    let cfg = app.state::<crate::settings::SettingsStore>().stats();
    let chosen = app.state::<crate::meta::MetaStore>().activity(path);
    let activity = app
        .state::<crate::library::Library>()
        .summarize(path, &cfg, chosen)
        .map(|(s, _)| s.activity)
        .unwrap_or_default();
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(60))
        .user_agent(concat!("GPXer/", env!("CARGO_PKG_VERSION")))
        .build();
    rewrite_record(app, path, |gpx| {
        if gpx_core::snap::median_step_m(gpx).is_some_and(|d| d < DENSE_STEP_M) {
            return Err(
                "Bu kayıt zaten sık noktalı; yola oturtma seyrek kayıtlar (ör. Google konum geçmişi) içindir"
                    .into(),
            );
        }
        let points: usize = gpx
            .tracks
            .iter()
            .chain(&gpx.routes)
            .flat_map(|t| t.segments.iter())
            .map(Vec::len)
            .sum();
        if points / (gpx_core::snap::MAX_CHUNK - 1) + 1 > MAX_REQUESTS {
            return Err("Kayıt yola oturtmak için çok uzun; önce bölün".into());
        }
        let n = gpx_core::snap::snap_to_roads(gpx, |c| {
            match_chunk(&agent, base, profile(activity), c)
        })?;
        if n == 0 {
            return Err("Kayıt yollarla eşleştirilemedi".into());
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_osrm_match_response() {
        // 4 nokta: 0-1-2 tek eşleşmede, 3 eşleşmedi.
        let v = json!({
            "code": "Ok",
            "tracepoints": [
                {"matchings_index": 0, "waypoint_index": 0, "location": [29.0, 41.0]},
                {"matchings_index": 0, "waypoint_index": 1, "location": [29.01, 41.0]},
                {"matchings_index": 0, "waypoint_index": 2, "location": [29.02, 41.0]},
                null
            ],
            "matchings": [{
                "geometry": {"coordinates": [[29.0, 41.0], [29.005, 41.001], [29.01, 41.0], [29.015, 41.001], [29.016, 41.001], [29.02, 41.0]]},
                "legs": [
                    {"annotation": {"distance": [1.0, 1.0]}},
                    {"annotation": {"distance": [1.0, 1.0, 1.0]}}
                ]
            }]
        });
        let m = parse_match(&v, 4);
        assert_eq!(m.snapped[1], Some((41.0, 29.01)));
        assert_eq!(m.snapped[3], None);
        assert_eq!(m.legs[0].as_ref().unwrap().len(), 3);
        assert_eq!(m.legs[1].as_ref().unwrap().len(), 4);
        assert_eq!(m.legs[1].as_ref().unwrap()[1], (41.001, 29.015));
        assert!(m.legs[2].is_none());
        let none = parse_match(&json!({"code": "NoMatch"}), 3);
        assert!(none.snapped.iter().all(Option::is_none));
    }

    /// Tek isteğe yanıt veren yerel sunucu; istek satırını geri verir.
    fn serve(status: &str, body: &'static str) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let status = status.to_owned();
        std::thread::spawn(move || {
            let mut s = listener.incoming().next().unwrap().unwrap();
            let mut line = String::new();
            BufReader::new(&s).read_line(&mut line).unwrap();
            tx.send(line).unwrap();
            write!(
                s,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        (format!("http://{addr}"), rx)
    }

    #[test]
    fn no_match_keeps_points_and_request_is_well_formed() {
        let (base, rx) = serve("400 Bad Request", r#"{"code":"NoMatch"}"#);
        let agent = ureq::AgentBuilder::new().build();
        let pts = [(41.0, 29.0, Some(60_000)), (41.01, 29.01, Some(120_000))];
        let m = match_chunk(&agent, &base, "routed-car", &pts).unwrap();
        assert!(m.snapped.iter().all(Option::is_none));
        let line = rx.recv().unwrap();
        assert!(
            line.contains("/routed-car/match/v1/driving/29.000000,41.000000;29.010000,41.010000?"),
            "{line}"
        );
        assert!(line.contains("timestamps=60%3B120"), "{line}");
    }
}
