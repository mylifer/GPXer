//! Geliştirme aracı: verilen GPX dosyalarını okur, süreyi ölçer ve özetleri
//! JSON olarak yazar.
//!
//! cargo run --release -p gpx-core --example dump -- <çıktı.json> dosya1.gpx ...

use std::time::Instant;

fn main() {
    let mut args = std::env::args().skip(1);
    let out = args.next().expect("çıktı dosyası gerekli");
    let paths: Vec<String> = args.collect();
    let started = Instant::now();
    let mut summaries = Vec::new();
    let mut errors = Vec::new();
    for p in &paths {
        match gpx_core::load_summary(p.as_ref(), &Default::default()) {
            Ok(s) => summaries.push(s),
            Err(e) => errors.push(serde_json::json!({ "path": p, "message": e.to_string() })),
        }
    }
    let elapsed = started.elapsed();
    let points: usize = summaries.iter().map(|s| s.stats.point_count).sum();
    let line_points: usize = summaries
        .iter()
        .flat_map(|s| &s.lines)
        .map(|l| l.len())
        .sum();
    let detail = summaries
        .first()
        .map(|s| gpx_core::load_detail(s.path.as_ref()).unwrap());
    let json = serde_json::json!({ "summaries": summaries, "errors": errors, "detail": detail });
    let text = serde_json::to_string(&json).unwrap();
    std::fs::write(&out, &text).unwrap();
    eprintln!(
        "{} dosya, {} hata, {} nokta → {} harita noktası; {:?} (tek iş parçacığı); JSON {} KB",
        summaries.len(),
        errors.len(),
        points,
        line_points,
        elapsed,
        text.len() / 1024
    );
}
