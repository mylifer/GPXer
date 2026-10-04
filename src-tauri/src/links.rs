//! Haritadaki bir yeri tarayıcıda sokak görünümüyle açma. Adres burada
//! kurulur: arayüz yalnızca konumu ve servisi verir, rastgele adres açamaz.

use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

pub(crate) fn street_view_url(service: &str, lat: f64, lon: f64) -> Result<String, String> {
    if !(lat.is_finite() && lon.is_finite() && lat.abs() <= 90.0 && lon.abs() <= 180.0) {
        return Err("Geçersiz konum".into());
    }
    Ok(match service {
        // Google Haritalar adresleri: yakındaki ilk panorama açılır.
        "google" => format!(
            "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat:.6},{lon:.6}"
        ),
        // Yandex Panorama (sırası boylam, enlem).
        "yandex" => format!(
            "https://yandex.com.tr/maps/?ll={lon:.6},{lat:.6}&z=17&l=stv,sta&panorama[point]={lon:.6},{lat:.6}"
        ),
        _ => return Err("Bilinmeyen servis".into()),
    })
}

/// Sokak görünümünü varsayılan tarayıcıda açar.
#[tauri::command]
pub(crate) fn open_street_view(
    app: AppHandle,
    service: String,
    lat: f64,
    lon: f64,
) -> Result<(), String> {
    let url = street_view_url(&service, lat, lon)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("Tarayıcı açılamadı: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_street_view_urls() {
        assert_eq!(
            street_view_url("google", 41.0123456, 28.9765432).unwrap(),
            "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=41.012346,28.976543"
        );
        assert!(street_view_url("yandex", 41.0, 29.0)
            .unwrap()
            .ends_with("panorama[point]=29.000000,41.000000"));
        assert!(street_view_url("javascript", 41.0, 29.0).is_err());
        assert!(street_view_url("google", f64::NAN, 29.0).is_err());
    }
}
