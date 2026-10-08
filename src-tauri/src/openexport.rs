//! Uygulamadan bağımsız açık arşiv: kütüphanenin tamamı tek klasöre, yıllar
//! sonra GPXer olmadan da okunabilecek biçimde çıkarılır: orijinal kayıt
//! dosyaları, kayıt listesi (CSV), etiket/not, yerler ve yer imleri (JSON) ve
//! tarayıcıda açılan bir dizin sayfası (HTML).

use crate::bookmarks::BookmarkStore;
use crate::health::ymd;
use crate::library::Library;
use crate::meta::{FileMeta, MetaStore};
use crate::places::PlacesStore;
use crate::run_blocking;
use crate::settings::SettingsStore;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Listede bir kayıt.
#[derive(Debug, Clone, Default)]
pub(crate) struct Row {
    /// Klasördeki dosya adı (kayitlar/ altında).
    pub file: String,
    pub name: String,
    pub start: Option<i64>,
    pub end: Option<i64>,
    pub time_zone: String,
    pub distance_m: f64,
    pub moving_ms: Option<i64>,
    pub activity: String,
    pub start_place: String,
    pub end_place: String,
    pub countries: Vec<String>,
    pub tags: Vec<String>,
    pub people: Vec<String>,
    pub note: String,
    /// Haritadaki çizgi (sadeleştirilmiş, [boylam, enlem]).
    pub line: Vec<Vec<[f64; 2]>>,
    /// İliştirilen belgeler (ekler/ altındaki adlar).
    pub attachments: Vec<String>,
}

/// UTC ISO 8601 ("2024-07-09T07:00:00Z").
fn iso(ms: i64) -> String {
    let s = ms.div_euclid(1000).rem_euclid(86_400);
    format!(
        "{}T{:02}:{:02}:{:02}Z",
        ymd(ms),
        s / 3600,
        s / 60 % 60,
        s % 60
    )
}

fn csv(v: &str) -> String {
    if v.contains([',', '"', '\n', '\r', ';']) {
        format!("\"{}\"", v.replace('"', "\"\""))
    } else {
        v.to_owned()
    }
}

fn html(v: &str) -> String {
    v.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub(crate) fn csv_text(rows: &[Row]) -> String {
    let mut out = String::from(
        "dosya,ad,baslangic_utc,bitis_utc,saat_dilimi,mesafe_km,hareket_dk,tur,baslangic_yeri,bitis_yeri,ulkeler,etiketler,kisiler,not\n",
    );
    for r in rows {
        let cells = [
            r.file.clone(),
            r.name.clone(),
            r.start.map(iso).unwrap_or_default(),
            r.end.map(iso).unwrap_or_default(),
            r.time_zone.clone(),
            format!("{:.2}", r.distance_m / 1000.0),
            r.moving_ms
                .map(|m| (m / 60_000).to_string())
                .unwrap_or_default(),
            r.activity.clone(),
            r.start_place.clone(),
            r.end_place.clone(),
            r.countries.join(" "),
            r.tags.join(" "),
            r.people.join("; "),
            r.note.clone(),
        ];
        out.push_str(&cells.iter().map(|c| csv(c)).collect::<Vec<_>>().join(","));
        out.push('\n');
    }
    out
}

pub(crate) fn index_html(rows: &[Row], created: i64) -> String {
    let total: f64 = rows.iter().map(|r| r.distance_m).sum();
    let mut body = String::new();
    let mut year = String::new();
    // Harita verisi: kayıt sırası, yıl, ad, tarih ve çizgiler (5 ondalık ≈ 1 m).
    let mut data = String::from("[");
    for (i, r) in rows.iter().enumerate() {
        let y = r
            .start
            .map(|t| ymd(t)[..4].to_owned())
            .unwrap_or_else(|| "Tarihsiz".into());
        if y != year {
            body.push_str(&format!(
                "<tr class=\"y\"><th colspan=\"5\">{}</th></tr>\n",
                html(&y)
            ));
            year = y.clone();
        }
        let route = [r.start_place.as_str(), r.end_place.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" → ");
        let docs: String = r
            .attachments
            .iter()
            .map(|a| {
                let shown = a.split_once('-').map_or(a.as_str(), |(_, n)| n);
                format!(
                    " <a class=\"doc\" href=\"ekler/{}\">📎 {}</a>",
                    html(&url_path(a)),
                    html(shown)
                )
            })
            .collect();
        body.push_str(&format!(
            "<tr id=\"k{i}\"><td>{}</td><td><a href=\"kayitlar/{}\">{}</a></td><td>{}</td><td class=\"n\">{:.1} km</td><td>{}{docs}</td></tr>\n",
            r.start.map(ymd).unwrap_or_default(),
            html(&url_path(&r.file)),
            html(&r.name),
            html(&route),
            r.distance_m / 1000.0,
            html(&[r.tags.join(", "), r.people.join(", "), r.note.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" — ")),
        ));
        if i > 0 {
            data.push(',');
        }
        let lines: Vec<String> = r
            .line
            .iter()
            .filter(|l| l.len() > 1)
            .map(|l| {
                let pts: Vec<String> = l
                    .iter()
                    .filter(|p| p[0].is_finite() && p[1].is_finite())
                    .map(|p| format!("{:.5},{:.5}", p[0], p[1]))
                    .collect();
                format!("[{}]", pts.join(","))
            })
            .collect();
        data.push_str(&format!(
            "{{\"y\":{},\"n\":{},\"d\":{},\"l\":[{}]}}",
            serde_json::to_string(&y).unwrap_or_default(),
            serde_json::to_string(&r.name).unwrap_or_default(),
            serde_json::to_string(&r.start.map(ymd).unwrap_or_default()).unwrap_or_default(),
            lines.join(",")
        ));
    }
    data.push(']');
    // </script> kapanışı veri içinde olamaz.
    let data = data.replace("</", "<\\/");
    format!(
        "<!doctype html><html lang=\"tr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>GPXer arşivi</title>
<style>body{{font:14px system-ui,sans-serif;margin:24px;color:#222}}table{{border-collapse:collapse;width:100%}}td,th{{padding:4px 8px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}}tr.y th{{background:#f3f1ec;font-size:16px}}.n{{text-align:right;white-space:nowrap}}a{{color:#1f6e49}}a.doc{{white-space:nowrap}}tr.hl td{{background:#fff4c2}}#map{{width:100%;height:60vh;min-height:320px;background:#f3f1ec;border-radius:8px;cursor:grab;display:block;touch-action:none}}#tip{{position:fixed;pointer-events:none;background:#222;color:#fff;padding:4px 8px;border-radius:4px;font-size:12px;display:none}}#legend span{{display:inline-block;margin-right:12px}}#legend i{{display:inline-block;width:12px;height:4px;margin-right:4px;vertical-align:middle}}</style></head><body>
<h1>GPXer arşivi</h1><p>{} kayıt · {:.0} km · oluşturulma {}. Kayıt dosyaları <code>kayitlar/</code> klasöründe (GPX ve benzeri açık biçimler); liste <code>kayitlar.csv</code>, etiket ve notlar <code>bilgiler.json</code>, iliştirilen belgeler <code>ekler/</code> içinde.</p>
<canvas id=\"map\"></canvas><p id=\"legend\"></p><div id=\"tip\"></div>
<p style=\"color:#666;font-size:12px\">Harita internetsiz çalışır (altlık yok): tekerlekle yakınlaştırın, sürükleyerek kaydırın, bir ize tıklayınca listedeki satırına gidilir.</p>
<table><thead><tr><th>Tarih</th><th>Kayıt</th><th>Güzergâh</th><th>Mesafe</th><th>Etiket / not</th></tr></thead><tbody>
{}</tbody></table>
<script>
const D={data};
{MAP_JS}
</script></body></html>
",
        rows.len(),
        total / 1000.0,
        ymd(created),
        body,
    )
}

/// Açık arşivin dizin sayfasındaki internetsiz harita (kütüphanesiz tuval).
const MAP_JS: &str = r#"(function(){
const cv=document.getElementById('map'),ctx=cv.getContext('2d'),tip=document.getElementById('tip');
const C=['#1f77b4','#d62728','#2ca02c','#ff7f0e','#9467bd','#8c564b','#e377c2','#17becf','#bcbd22','#7f7f7f'];
const years=[...new Set(D.map(r=>r.y))].sort();const col=y=>C[years.indexOf(y)%C.length];
document.getElementById('legend').innerHTML=years.map(y=>'<span><i style="background:'+col(y)+'"></i>'+y+'</span>').join('');
const X=lon=>(lon+180)/360,Y=lat=>{const s=Math.sin(Math.max(-85,Math.min(85,lat))*Math.PI/180);return .5-Math.log((1+s)/(1-s))/(4*Math.PI)};
const P=D.map(r=>r.l.map(l=>{const o=[];for(let i=0;i<l.length;i+=2)o.push([X(l[i]),Y(l[i+1])]);return o}));
let x0=1,x1=0,y0=1,y1=0;P.flat(2).forEach(([x,y])=>{x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y)});
let k=1,ox=0,oy=0,hi=-1,W=0,H=0;
function fit(){const r=cv.getBoundingClientRect(),d=devicePixelRatio||1;W=r.width;H=r.height;cv.width=W*d;cv.height=H*d;ctx.setTransform(d,0,0,d,0,0);
 if(x1<x0){k=W;ox=0;oy=0;return}const s=Math.max(x1-x0,y1-y0,1e-6);k=Math.min((W-40)/Math.max(x1-x0,s*.05),(H-40)/Math.max(y1-y0,s*.05));ox=W/2-(x0+x1)/2*k;oy=H/2-(y0+y1)/2*k}
function draw(){ctx.clearRect(0,0,W,H);ctx.lineJoin=ctx.lineCap='round';
 P.forEach((ls,i)=>{ctx.strokeStyle=col(D[i].y);ctx.lineWidth=i===hi?4:1.6;ctx.globalAlpha=hi<0||i===hi?.9:.35;
  ls.forEach(l=>{ctx.beginPath();l.forEach(([x,y],j)=>j?ctx.lineTo(x*k+ox,y*k+oy):ctx.moveTo(x*k+ox,y*k+oy));ctx.stroke()})});ctx.globalAlpha=1}
function near(mx,my){let best=-1,bd=64;P.forEach((ls,i)=>ls.forEach(l=>{for(let j=1;j<l.length;j++){const ax=l[j-1][0]*k+ox,ay=l[j-1][1]*k+oy,bx=l[j][0]*k+ox,by=l[j][1]*k+oy,dx=bx-ax,dy=by-ay,L=dx*dx+dy*dy,t=L?Math.max(0,Math.min(1,((mx-ax)*dx+(my-ay)*dy)/L)):0,ex=ax+t*dx-mx,ey=ay+t*dy-my,d=ex*ex+ey*ey;if(d<bd){bd=d;best=i}}}));return best}
let drag=null;
cv.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY,ox,oy,moved:false};cv.setPointerCapture(e.pointerId)});
cv.addEventListener('pointermove',e=>{const r=cv.getBoundingClientRect();
 if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;ox=drag.ox+dx;oy=drag.oy+dy;draw();return}
 const i=near(e.clientX-r.left,e.clientY-r.top);if(i!==hi){hi=i;draw()}
 if(i>=0){tip.style.display='block';tip.style.left=e.clientX+12+'px';tip.style.top=e.clientY+12+'px';tip.textContent=D[i].d+' · '+D[i].n}else tip.style.display='none'});
cv.addEventListener('pointerup',e=>{const r=cv.getBoundingClientRect(),moved=drag&&drag.moved;drag=null;if(moved)return;
 const i=near(e.clientX-r.left,e.clientY-r.top);if(i<0)return;document.querySelectorAll('tr.hl').forEach(t=>t.classList.remove('hl'));
 const row=document.getElementById('k'+i);if(row){row.classList.add('hl');row.scrollIntoView({behavior:'smooth',block:'center'})}});
cv.addEventListener('pointerleave',()=>{tip.style.display='none';if(hi>=0){hi=-1;draw()}});
cv.addEventListener('wheel',e=>{e.preventDefault();const r=cv.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top,f=Math.exp(-e.deltaY*.0015);ox=mx-(mx-ox)*f;oy=my-(my-oy)*f;k*=f;draw()},{passive:false});
cv.addEventListener('dblclick',()=>{fit();draw()});
addEventListener('resize',()=>{fit();draw()});fit();draw();
})();"#;

/// Bağlantıda dosya adındaki boşluk ve özel karakterler kodlanır.
fn url_path(name: &str) -> String {
    let mut out = String::new();
    for b in name.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

const README: &str = "GPXer arşivi

Bu klasör GPXer olmadan da kullanılabilir:

- kayitlar/        Orijinal kayıt dosyaları (GPX, FIT, TCX, KML…). Her harita ve
                   GPS programı açabilir.
- kayitlar.csv     Her kaydın dosyası, adı, başlangıç/bitiş zamanı (UTC), saat
                   dilimi, mesafesi, hareket süresi, türü, başlangıç ve bitiş
                   yeri, geçtiği ülkeler, etiketleri, birlikte olunan kişiler ve notu (UTF-8, virgülle
                   ayrılmış; Excel, LibreOffice ve benzerleri açar).
- bilgiler.json    Etiket, not ve tür (dosya adına göre).
- yerler.json      Adlandırılmış yerler (ev, iş…; enlem/boylam, yarıçap).
- yer-imleri.json  Haritada işaretlenen yerler.
- gunluk.json      Günlük notları (gün → metin).
- ekler/           Kayıtlara iliştirilen belgeler (bilet, fatura, ses kaydı…).
- index.html       Tarayıcıda açılan, internetsiz harita ve yıllara göre
                   kayıt listesi.

GPXer'e geri almak için kayitlar/ klasörünü Dosya → Klasör aç ile açabilirsiniz.
";

/// Açık arşivi `dest` klasörüne yazar; yazılan kayıt sayısı.
pub(crate) fn write_open_archive(
    dest: &Path,
    records: &[(PathBuf, Row)],
    extras: &[(&str, Vec<u8>)],
    attach_dir: Option<&Path>,
    created: i64,
) -> std::io::Result<usize> {
    let rec_dir = dest.join("kayitlar");
    std::fs::create_dir_all(&rec_dir)?;
    // İliştirilen belgeler (bu bilgisayarda olanlar).
    if let Some(dir) = attach_dir {
        let mut done = HashSet::new();
        for name in records.iter().flat_map(|(_, r)| r.attachments.iter()) {
            let Some(src) = crate::attachments::path_in(dir, name) else {
                continue;
            };
            if done.insert(name.clone()) && src.is_file() {
                let out = dest.join("ekler");
                std::fs::create_dir_all(&out)?;
                std::fs::copy(&src, out.join(name))?;
            }
        }
    }
    let mut rows = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    for (src, row) in records {
        // Aynı adlı dosyalar (farklı klasörlerden) çakışmasın.
        let mut name = row.file.clone();
        let mut k = 2;
        while !used.insert(name.to_lowercase()) {
            let p = Path::new(&row.file);
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("kayit");
            let ext = p
                .extension()
                .and_then(|s| s.to_str())
                .map(|e| format!(".{e}"))
                .unwrap_or_default();
            name = format!("{stem}-{k}{ext}");
            k += 1;
        }
        std::fs::copy(src, rec_dir.join(&name))?;
        rows.push(Row {
            file: name,
            ..row.clone()
        });
    }
    rows.sort_by_key(|r| r.start.unwrap_or(i64::MAX));
    let put = |name: &str, bytes: &[u8]| -> std::io::Result<()> {
        std::fs::File::create(dest.join(name))?.write_all(bytes)
    };
    // UTF-8 BOM: Excel Türkçe karakterleri doğru göstersin.
    put(
        "kayitlar.csv",
        format!("\u{feff}{}", csv_text(&rows)).as_bytes(),
    )?;
    put("index.html", index_html(&rows, created).as_bytes())?;
    put("OKUBENI.txt", README.as_bytes())?;
    for (n, b) in extras {
        put(n, b)?;
    }
    Ok(rows.len())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenExport {
    folder: String,
    records: usize,
}

/// Klasör seçme penceresini açar; seçilen klasörde "GPXer-arsiv-<tarih>"
/// klasörüne açık arşivi yazar. Vazgeçilirse `None`.
#[tauri::command]
pub(crate) async fn export_open_archive(app: AppHandle) -> Result<Option<OpenExport>, String> {
    run_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut dialog = app.dialog().file();
        if let Some(w) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&w);
        }
        let Some(parent) = dialog
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
        else {
            return Ok(None);
        };
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as i64);
        let mut dest = parent.join(format!("GPXer-arsiv-{}", ymd(now)));
        let mut k = 2;
        while dest.exists() {
            dest = parent.join(format!("GPXer-arsiv-{}-{k}", ymd(now)));
            k += 1;
        }
        let library = app.state::<Library>();
        let meta = app.state::<MetaStore>().all();
        let cfg = app.state::<SettingsStore>().stats();
        let empty = FileMeta::default();
        let mut by_name: HashMap<String, &FileMeta> = HashMap::new();
        let mut records = Vec::new();
        for path in library.files() {
            let m = meta.get(&path).unwrap_or(&empty);
            let file = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // Okunamayan (bozuk) kayıt da arşive girer: orijinal baytlar
            // kopyalanır, satırında yalnızca bilinenler olur.
            let Ok((s, _)) = library.summarize(&path, &cfg, m.activity) else {
                if meta.contains_key(&path) {
                    by_name.insert(file.clone(), m);
                }
                records.push((
                    PathBuf::from(&path),
                    Row {
                        name: format!("{file} (okunamadı)"),
                        file,
                        tags: m.tags.clone(),
                        people: m.people.clone(),
                        note: m.note.clone(),
                        attachments: m.attachments.clone(),
                        ..Row::default()
                    },
                ));
                continue;
            };
            if meta.contains_key(&path) {
                by_name.insert(file.clone(), m);
            }
            let mut countries: Vec<String> = Vec::new();
            for (_, cc, _) in &s.visits {
                if !countries.contains(cc) {
                    countries.push(cc.clone());
                }
            }
            records.push((
                PathBuf::from(&path),
                Row {
                    file,
                    name: s.name.clone().unwrap_or_else(|| s.file_name.clone()),
                    start: s.stats.start_time,
                    end: s.stats.end_time,
                    time_zone: s.time_zone.clone().unwrap_or_default(),
                    distance_m: s.stats.distance_m,
                    moving_ms: s.stats.moving_ms,
                    activity: serde_json::to_value(s.activity)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default(),
                    start_place: s.start_place.clone().unwrap_or_default(),
                    end_place: s.end_place.clone().unwrap_or_default(),
                    countries,
                    tags: m.tags.clone(),
                    people: m.people.clone(),
                    note: m.note.clone(),
                    line: s.lines.clone(),
                    attachments: m.attachments.clone(),
                },
            ));
        }
        let json = |v: serde_json::Result<Vec<u8>>| v.map_err(|e| e.to_string());
        let extras = vec![
            ("bilgiler.json", json(serde_json::to_vec_pretty(&by_name))?),
            (
                "yerler.json",
                json(serde_json::to_vec_pretty(&app.state::<PlacesStore>().all()))?,
            ),
            (
                "gunluk.json",
                json(serde_json::to_vec_pretty(
                    &app.state::<crate::journal::JournalStore>().all(),
                ))?,
            ),
            (
                "yer-imleri.json",
                json(serde_json::to_vec_pretty(
                    &app.state::<BookmarkStore>().all(),
                ))?,
            ),
        ];
        let attach = &app.state::<crate::attachments::Attachments>().0;
        let n = write_open_archive(&dest, &records, &extras, Some(attach), now)
            .map_err(|e| format!("Arşiv yazılamadı: {e}"))?;
        Ok(Some(OpenExport {
            folder: dest.to_string_lossy().into_owned(),
            records: n,
        }))
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_readable_archive() {
        let dir = std::env::temp_dir().join(format!("gpxer-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src");
        std::fs::create_dir_all(src.join("b")).unwrap();
        std::fs::write(src.join("iz.gpx"), b"<gpx>1</gpx>").unwrap();
        std::fs::write(src.join("b/iz.gpx"), b"<gpx>2</gpx>").unwrap();
        let row = |file: &str, name: &str, start: i64| Row {
            file: file.into(),
            name: name.into(),
            start: Some(start),
            distance_m: 160_000.0,
            start_place: "Bodrum".into(),
            end_place: "Marmaris".into(),
            tags: vec!["tatil".into()],
            people: vec!["Ayşe".into(), "Can".into()],
            note: "Denize, \"yüzmeye\" gittik".into(),
            line: vec![vec![[27.43, 37.04], [28.27, 36.85]]],
            attachments: vec!["1-bilet & fiş.pdf".into()],
            ..Row::default()
        };
        let ekler = dir.join("ekler");
        std::fs::create_dir_all(&ekler).unwrap();
        std::fs::write(ekler.join("1-bilet & fiş.pdf"), b"%PDF").unwrap();
        let recs = vec![
            (
                src.join("iz.gpx"),
                row("iz.gpx", "Muğla gezisi", 1_720_508_400_000),
            ),
            (
                src.join("iz.gpx"),
                row("c.gpx", "Kötü </script> ad", 1_720_508_500_000),
            ),
            (
                src.join("b/iz.gpx"),
                row("iz.gpx", "Eski kayıt", 1_600_000_000_000),
            ),
        ];
        let out = dir.join("arsiv");
        let n = write_open_archive(
            &out,
            &recs,
            &[("yerler.json", b"[]".to_vec())],
            Some(&ekler),
            1_720_508_400_000,
        )
        .unwrap();
        assert_eq!(n, 3);
        assert_eq!(
            std::fs::read(out.join("kayitlar/iz.gpx")).unwrap(),
            b"<gpx>1</gpx>"
        );
        assert_eq!(
            std::fs::read(out.join("kayitlar/iz-2.gpx")).unwrap(),
            b"<gpx>2</gpx>"
        );
        let csv = std::fs::read_to_string(out.join("kayitlar.csv")).unwrap();
        let lines: Vec<&str> = csv.lines().collect();
        assert_eq!(lines.len(), 4);
        // Tarih sırasıyla: eski kayıt önce.
        assert!(
            lines[1].starts_with("iz-2.gpx,Eski kayıt,2020-09-13T12:26:40Z"),
            "{}",
            lines[1]
        );
        assert!(lines[2].contains(",tatil,\"Ayşe; Can\",\"Denize, \"\"yüzmeye\"\" gittik\""));
        let html = std::fs::read_to_string(out.join("index.html")).unwrap();
        assert!(html.contains("<a href=\"kayitlar/iz.gpx\">Muğla gezisi</a>"));
        assert!(html.contains("Bodrum → Marmaris"));
        // Harita verisi: çizgi noktaları; veri içindeki </script> kaçırılır.
        assert!(html.contains("\"l\":[[27.43000,37.04000,28.27000,36.85000]]"));
        assert_eq!(html.matches("</script>").count(), 1);
        assert!(html.contains("href=\"ekler/1-bilet%20%26%20fi%C5%9F.pdf\""));
        assert_eq!(
            std::fs::read(out.join("ekler/1-bilet & fiş.pdf")).unwrap(),
            b"%PDF"
        );
        assert!(out.join("OKUBENI.txt").exists() && out.join("yerler.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
