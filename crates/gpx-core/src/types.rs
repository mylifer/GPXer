//! Arayüze gönderilen veri yapıları ve yükleme hatası.

use crate::analysis::{Activity, Stop};
use crate::parse::ParseError;
use crate::stats::Stats;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaypointOut {
    pub lat: f64,
    pub lon: f64,
    pub ele: Option<f32>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSummary {
    pub path: String,
    pub file_name: String,
    /// GPX içindeki ad (metadata ya da ilk track adı).
    pub name: Option<String>,
    pub file_size: u64,
    pub track_count: usize,
    pub route_count: usize,
    pub stats: Stats,
    /// Sadeleştirilmiş çizgiler, her biri [lon, lat] dizisi.
    pub lines: Vec<Vec<[f64; 2]>>,
    /// `lines` ile aynı düzende nokta zamanları (Unix ms). Dosyada hiç zaman
    /// bilgisi yoksa boş bırakılır.
    pub times: Vec<Vec<Option<i64>>>,
    /// Kayıt boşlukları (uzun süre ya da uzun mesafe nokta yok: uçuş, sinyal
    /// kaybı). `lines` bu yerlerde bölünür; harita boşluğu ayrıca gösterir.
    #[serde(default)]
    pub gaps: Vec<Gap>,
    /// Saatlik toplamlar `[saat başı (Unix ms, UTC), mesafe (m), hareket (ms)]`;
    /// yalnızca kayıt olan saatler. Çok günlük kayıtların takvimde, tarih
    /// filtresinde ve özette gün gün sayılması için (arayüz kendi saat
    /// dilimine göre günlere toplar).
    #[serde(default)]
    pub hours: Vec<[f64; 3]>,
    pub waypoints: Vec<WaypointOut>,
    /// Kaydın başladığı yerin IANA saat dilimi (ör. "Europe/Istanbul").
    /// Çekirdek doldurmaz; uygulama katmanı konumdan bulur.
    #[serde(default)]
    pub time_zone: Option<String>,
    /// Başlangıç noktası [lon, lat].
    #[serde(default)]
    pub start: Option<[f64; 2]>,
    /// Bitiş noktası [lon, lat].
    #[serde(default)]
    pub end: Option<[f64; 2]>,
    /// Başlangıç ve bitiş yerinin adı (uygulama katmanı doldurur).
    #[serde(default)]
    pub start_place: Option<String>,
    #[serde(default)]
    pub end_place: Option<String>,
    /// Saat saat geçilen yerler `[saat başı (Unix ms), ülke kodu, yer adı]`:
    /// `hours` içindeki her saatin ilk noktasının yeri; yalnızca bir önceki
    /// girdiden farklıysa eklenir. Uygulama katmanı doldurur
    /// ([`hour_first_points`](crate::hour_first_points)).
    #[serde(default)]
    pub visits: Vec<(i64, String, String)>,
    /// Etkinlik türü (seçilmişse o, değilse tahmin).
    #[serde(default)]
    pub activity: Activity,
    /// Türü kullanıcı mı seçti.
    #[serde(default)]
    pub activity_set: bool,
    #[serde(default)]
    pub stops: Vec<Stop>,
    /// Ayıklanan GPS sıçraması ve kopuk uç noktası sayısı.
    #[serde(default)]
    pub removed_points: usize,
    /// Uzun duraklamalar tek noktaya indirilirken atılan nokta sayısı.
    #[serde(default)]
    pub collapsed_points: usize,
}

/// Seçili dosyanın grafik verisi, sütun sütun (uPlot formatına uygun).
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    /// Başlangıçtan itibaren kümülatif mesafe (m).
    pub dist: Vec<f64>,
    pub ele: Vec<Option<f32>>,
    /// Yumuşatılmış anlık hız (km/sa).
    pub speed: Vec<Option<f32>>,
    pub time: Vec<Option<i64>>,
    pub lat: Vec<f64>,
    pub lon: Vec<f64>,
    /// Her örneğin hazırlanmış kayıttaki ([`prepare`](crate::prepare)) asıl nokta sırası
    /// (iz/rota segmentleri uç uca eklenmiş kabul edilir). Aralık istatistiği
    /// aynı sırayı kullanır; kırpma ve bölmede [`Prepared::raw_index`](crate::Prepared::raw_index) ile ham
    /// dosyadaki sıraya çevrilir.
    pub idx: Vec<u32>,
    /// Sensör verileri; dosyada hiç yoksa boş bırakılır.
    pub hr: Vec<Option<f32>>,
    pub cad: Vec<Option<f32>>,
    pub power: Vec<Option<f32>>,
    pub temp: Vec<Option<f32>>,
    /// Ardından kayıt boşluğu gelen örneklerin sırası: `k` listedeyse `k` ile
    /// `k + 1` arasındaki asıl noktalarda (seyreltmede atlananlar dahil) bir
    /// boşluk ([`is_gap`](crate::is_gap)) vardır. Harita çizgiyi burada keser.
    pub gap_after: Vec<u32>,
}

#[derive(Debug)]
pub enum LoadError {
    Io(std::io::Error),
    Parse(ParseError),
    Empty,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(e) => write!(f, "Dosya okunamadı: {e}"),
            LoadError::Parse(e) => write!(f, "{e}"),
            LoadError::Empty => f.write_str("Dosyada rota, iz ya da nokta bulunamadı"),
        }
    }
}

impl std::error::Error for LoadError {}

/// İz üzerinde nokta olmayan bir aralık.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    /// Boşluktan önceki ve sonraki nokta [lon, lat].
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub distance_m: f64,
}
