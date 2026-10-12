//! Yerinde düzenlenen GPX'i özgün dosyayı koruyarak yazma. Nokta taşıma,
//! silme, yükseklik düzeltme ve yola oturtma yalnızca iz noktalarını
//! değiştirir; dosyanın geri kalanı (açıklama, bağlantı, simge, tür, işaret
//! noktaları, rotalar, ad alanları, nokta eklentileri) olduğu gibi kalır.
//!
//! - Nokta sayısı değişmeyen segmentte her `<trkpt>` yerinde yamanır (yalnızca
//!   değişen enlem/boylam, yükseklik, zaman).
//! - Noktaları silinen segmentte kalanların özgün metni korunur.
//! - Geometrisi baştan değişen segment (yola oturtma) yeniden yazılır.
//!
//! Dosyanın yapısı beklenenle eşleşmezse `None`: çağıran baştan yazar.

use crate::parse::{parse_gpx, Gpx, Point};
use crate::write::{format_time, point};
use quick_xml::events::Event;
use quick_xml::Reader;

/// Bir `<trkpt>`'nin özgün metindeki bayt aralığı.
type Span = (usize, usize);

/// İz segmentlerindeki `<trkpt>` aralıkları (belge sırasıyla; boş segmentler
/// atlanır, ayrıştırıcı da onları atar).
fn track_point_spans(text: &str) -> Option<Vec<Vec<Span>>> {
    let mut r = Reader::from_str(text);
    let mut segs: Vec<Vec<Span>> = Vec::new();
    let mut in_trk = false;
    let mut cur: Option<Vec<Span>> = None;
    let mut open: Option<usize> = None;
    let mut depth_in_pt = 0usize;
    loop {
        let before = r.buffer_position() as usize;
        let ev = r.read_event().ok()?;
        let after = r.buffer_position() as usize;
        let local = |n: &[u8]| -> Vec<u8> { n.rsplit(|&c| c == b':').next().unwrap_or(n).to_vec() };
        match ev {
            Event::Eof => break,
            Event::Start(e) => {
                let n = local(e.name().as_ref());
                if open.is_some() {
                    depth_in_pt += 1;
                    continue;
                }
                match n.as_slice() {
                    b"trk" => in_trk = true,
                    b"trkseg" if in_trk => cur = Some(Vec::new()),
                    b"trkpt" if cur.is_some() => {
                        open = Some(before);
                        depth_in_pt = 0;
                    }
                    _ => {}
                }
            }
            Event::Empty(e) => {
                if open.is_none() && local(e.name().as_ref()) == b"trkpt" {
                    if let Some(c) = cur.as_mut() {
                        c.push((before, after));
                    }
                }
            }
            Event::End(e) => {
                let n = local(e.name().as_ref());
                if let Some(start) = open {
                    if depth_in_pt > 0 {
                        depth_in_pt -= 1;
                        continue;
                    }
                    if n == b"trkpt" {
                        cur.as_mut()?.push((start, after));
                        open = None;
                    }
                    continue;
                }
                match n.as_slice() {
                    b"trkseg" => {
                        if let Some(c) = cur.take() {
                            if !c.is_empty() {
                                segs.push(c);
                            }
                        }
                    }
                    b"trk" => in_trk = false,
                    _ => {}
                }
            }
            _ => {}
        }
    }
    Some(segs)
}

/// Başlangıç etiketindeki bir özniteliğin değerini değiştirir.
fn set_attr(tag: &str, name: &str, value: &str) -> Option<String> {
    let bytes = tag.as_bytes();
    let mut i = 0;
    while let Some(off) = tag[i..].find(name) {
        let at = i + off;
        let before_ok = at > 0 && bytes[at - 1].is_ascii_whitespace();
        let rest = &tag[at + name.len()..];
        let eq = rest.trim_start();
        if before_ok && eq.starts_with('=') {
            let after_eq = eq[1..].trim_start();
            let q = after_eq.chars().next()?;
            if q == '"' || q == '\'' {
                let val_start = tag.len() - after_eq.len() + 1;
                let val_end = val_start + after_eq[1..].find(q)?;
                return Some(format!("{}{}{}", &tag[..val_start], value, &tag[val_end..]));
            }
        }
        i = at + name.len();
    }
    None
}

/// Noktanın (özgün metin) bir alt öğesinin değerini değiştirir, ekler ya da
/// kaldırır. `<trkpt .../>` gerekirse açılır.
fn set_child(pt: &str, child: &str, value: Option<&str>) -> Option<String> {
    let self_closing = pt.trim_end().ends_with("/>") && !pt.contains("</");
    let open_end = pt.find('>')? + 1;
    let (head, body, tail) = if self_closing {
        let h = pt[..pt.rfind("/>")?].trim_end();
        (format!("{h}>"), String::new(), String::from("</trkpt>"))
    } else {
        let close = pt.rfind("</")?;
        (
            pt[..open_end].to_owned(),
            pt[open_end..close].to_owned(),
            pt[close..].to_owned(),
        )
    };
    // Önekli (gpx:ele) ya da öneksiz alt öğe.
    let find_open = |b: &str| -> Option<(usize, String)> {
        let mut i = 0;
        while let Some(off) = b[i..].find('<') {
            let at = i + off;
            let name: String = b[at + 1..]
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '>' && *c != '/')
                .collect();
            if name.rsplit(':').next() == Some(child) && !name.starts_with('/') {
                return Some((at, name));
            }
            i = at + 1;
        }
        None
    };
    let new_body = match (find_open(&body), value) {
        (Some((at, name)), v) => {
            let close_tag = format!("</{name}>");
            let start_end = at + body[at..].find('>')? + 1;
            let end = if body[at..start_end].ends_with("/>") {
                start_end
            } else {
                start_end + body[start_end..].find(&close_tag)? + close_tag.len()
            };
            match v {
                Some(v) => format!("{}<{name}>{v}</{name}>{}", &body[..at], &body[end..]),
                None => format!("{}{}", &body[..at], &body[end..]),
            }
        }
        (None, Some(v)) => format!("<{child}>{v}</{child}>{body}"),
        (None, None) => body,
    };
    Some(format!("{head}{new_body}{tail}"))
}

/// Özgün noktanın metnini yeni değerlere göre yamar (değişmeyen alanlara
/// dokunmaz).
fn patch_point(raw: &str, old: &Point, new: &Point) -> Option<String> {
    let mut s = raw.to_owned();
    if old.lat != new.lat || old.lon != new.lon {
        let tag_end = s.find('>')?;
        let tag = &s[..tag_end];
        let tag = set_attr(tag, "lat", &new.lat.to_string())?;
        let tag = set_attr(&tag, "lon", &new.lon.to_string())?;
        s = format!("{tag}{}", &s[tag_end..]);
    }
    if old.ele != new.ele {
        s = set_child(&s, "ele", new.ele.map(|e| e.to_string()).as_deref())?;
    }
    if old.time != new.time {
        s = set_child(&s, "time", new.time.map(format_time).as_deref())?;
    }
    Some(s)
}

fn same_place(a: &Point, b: &Point) -> bool {
    a.lat == b.lat && a.lon == b.lon && a.time == b.time
}

/// `new`, özgün dosya `text` üzerine yamanmış olarak; yapı eşleşmezse `None`.
pub fn patch_gpx(text: &str, new: &Gpx) -> Option<String> {
    let old = parse_gpx(text.as_bytes()).ok()?;
    // Yalnızca iz noktaları değişmiş olmalı.
    if new.tracks.is_empty()
        || old.tracks.len() != new.tracks.len()
        || old.routes != new.routes
        || old.waypoints != new.waypoints
        || old.name != new.name
    {
        return None;
    }
    let spans = track_point_spans(text)?;
    let old_segs: Vec<&Vec<Point>> = old.tracks.iter().flat_map(|t| t.segments.iter()).collect();
    let new_segs: Vec<&Vec<Point>> = new.tracks.iter().flat_map(|t| t.segments.iter()).collect();
    if spans.len() != old_segs.len()
        || old_segs.len() != new_segs.len()
        || spans.iter().zip(&old_segs).any(|(s, o)| s.len() != o.len())
        || old
            .tracks
            .iter()
            .zip(&new.tracks)
            .any(|(a, b)| a.segments.len() != b.segments.len())
    {
        return None;
    }
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    for ((sp, o), n) in spans.iter().zip(&old_segs).zip(&new_segs) {
        let raw = |i: usize| &text[sp[i].0..sp[i].1];
        if o.len() == n.len() {
            for i in 0..o.len() {
                out.push_str(&text[pos..sp[i].0]);
                if o[i] == n[i] {
                    out.push_str(raw(i));
                } else {
                    out.push_str(&patch_point(raw(i), &o[i], &n[i])?);
                }
                pos = sp[i].1;
            }
            continue;
        }
        // Silinmiş noktalar: kalanlar sırayla eşleşiyorsa özgün metinleri korunur.
        let mut keep = Vec::with_capacity(n.len());
        let mut j = 0;
        for (i, p) in o.iter().enumerate() {
            if j < n.len() && same_place(p, &n[j]) {
                keep.push(i);
                j += 1;
            }
        }
        let first = sp[0].0;
        let last = sp[sp.len() - 1].1;
        out.push_str(&text[pos..first]);
        if j == n.len() && n.len() < o.len() {
            // Noktalar arasındaki boşluk (girinti) ilk noktanınkiyle aynı tutulur.
            let gap = if sp.len() > 1 {
                &text[sp[0].1..sp[1].0]
            } else {
                "\n"
            };
            for (k, &i) in keep.iter().enumerate() {
                if k > 0 {
                    out.push_str(gap);
                }
                out.push_str(raw(i));
            }
        } else {
            // Geometri baştan değişti (yola oturtma): segment yeniden yazılır.
            let mut seg = String::new();
            for p in n.iter() {
                point(&mut seg, "trkpt", p, None, "");
            }
            out.push_str(seg.trim_end());
        }
        pos = last;
    }
    out.push_str(&text[pos..]);
    // Güvenlik: yamalı dosya yeniden okunduğunda tam olarak istenen noktalar.
    let check = parse_gpx(out.as_bytes()).ok()?;
    let got: Vec<&Point> = check
        .tracks
        .iter()
        .flat_map(|t| t.segments.iter().flatten())
        .collect();
    let want: Vec<&Point> = new
        .tracks
        .iter()
        .flat_map(|t| t.segments.iter().flatten())
        .collect();
    (got.len() == want.len()
        && got
            .iter()
            .zip(&want)
            .all(|(a, b)| same_place(a, b) && a.ele == b.ele))
    .then_some(out)
}
