//! GPX 1.1 yazıcı. Sensör verileri Garmin TrackPointExtension v1 biçiminde
//! yazılır; güç için yaygın kullanılan `<power>` uzantısı eklenir.

use crate::parse::{Gpx, Point};
use std::fmt::Write;

/// Yazıcıların metni eklediği hedef: `String` ya da (akış halinde yazmak
/// için) [`IoSink`]. `fmt::Write` hatası yazıcılarda yok sayılır; G/Ç hatası
/// [`IoSink`] içinde saklanıp sonda döndürülür.
pub(crate) trait Sink: Write {
    fn push_str(&mut self, s: &str) {
        let _ = self.write_str(s);
    }
    fn push(&mut self, c: char) {
        let _ = self.write_char(c);
    }
}

impl<T: Write + ?Sized> Sink for T {}

/// `io::Write` hedefini `fmt::Write` olarak kullanır; ilk G/Ç hatası
/// saklanır, sonraki yazmalar yapılmaz.
pub(crate) struct IoSink<'a, W: std::io::Write> {
    inner: &'a mut W,
    err: Option<std::io::Error>,
}

impl<W: std::io::Write> Write for IoSink<'_, W> {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        if self.err.is_some() {
            return Err(std::fmt::Error);
        }
        self.inner.write_all(s.as_bytes()).map_err(|e| {
            self.err = Some(e);
            std::fmt::Error
        })
    }
}

/// `f`'nin ürettiği metni `w`'ye akış halinde yazar.
pub(crate) fn stream<W: std::io::Write>(
    w: &mut W,
    f: impl FnOnce(&mut IoSink<'_, W>),
) -> std::io::Result<()> {
    let mut sink = IoSink {
        inner: w,
        err: None,
    };
    f(&mut sink);
    match sink.err {
        Some(e) => Err(e),
        None => w.flush(),
    }
}

/// XML metni için kaçış (öğe içeriği ve çift tırnaklı öznitelik değeri).
pub(crate) fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn format_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|d| {
            if ms % 1000 == 0 {
                d.format("%Y-%m-%dT%H:%M:%SZ").to_string()
            } else {
                d.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
            }
        })
        .unwrap_or_default()
}

fn point<S: Sink + ?Sized>(out: &mut S, tag: &str, p: &Point, name: Option<&str>, indent: &str) {
    let _ = write!(
        out,
        // `{}` f64'ü kayıpsız (en kısa geri dönüşümlü) biçimde yazar.
        "{indent}<{tag} lat=\"{}\" lon=\"{}\"",
        p.lat, p.lon
    );
    let has_ext = p.hr.is_some() || p.cad.is_some() || p.temp.is_some() || p.power.is_some();
    if p.ele.is_none() && p.time.is_none() && name.is_none() && !has_ext {
        out.push_str("/>\n");
        return;
    }
    out.push('>');
    if let Some(e) = p.ele {
        let _ = write!(out, "<ele>{e}</ele>");
    }
    if let Some(t) = p.time {
        let _ = write!(out, "<time>{}</time>", format_time(t));
    }
    if let Some(n) = name {
        let _ = write!(out, "<name>{}</name>", esc(n));
    }
    if has_ext {
        out.push_str("<extensions>");
        if let Some(v) = p.power {
            let _ = write!(out, "<power>{v}</power>");
        }
        if p.hr.is_some() || p.cad.is_some() || p.temp.is_some() {
            out.push_str("<gpxtpx:TrackPointExtension>");
            if let Some(v) = p.temp {
                let _ = write!(out, "<gpxtpx:atemp>{v}</gpxtpx:atemp>");
            }
            if let Some(v) = p.hr {
                let _ = write!(out, "<gpxtpx:hr>{}</gpxtpx:hr>", v.round());
            }
            if let Some(v) = p.cad {
                let _ = write!(out, "<gpxtpx:cad>{}</gpxtpx:cad>", v.round());
            }
            out.push_str("</gpxtpx:TrackPointExtension>");
        }
        out.push_str("</extensions>");
    }
    let _ = writeln!(out, "</{tag}>");
}

pub fn write_gpx(gpx: &Gpx) -> String {
    let mut out = String::with_capacity(1 << 16);
    write_gpx_into(gpx, &mut out);
    out
}

/// GPX'i bellekte tamamını tutmadan `w`'ye yazar.
pub fn write_gpx_to<W: std::io::Write>(gpx: &Gpx, w: &mut W) -> std::io::Result<()> {
    stream(w, |s| write_gpx_into(gpx, s))
}

fn write_gpx_into<S: Sink + ?Sized>(gpx: &Gpx, out: &mut S) {
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str(
        "<gpx version=\"1.1\" creator=\"GPXer\" xmlns=\"http://www.topografix.com/GPX/1/1\" \
         xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">\n",
    );
    if gpx.name.is_some() || gpx.time.is_some() {
        out.push_str("  <metadata>");
        if let Some(n) = &gpx.name {
            let _ = write!(out, "<name>{}</name>", esc(n));
        }
        if let Some(t) = gpx.time {
            let _ = write!(out, "<time>{}</time>", format_time(t));
        }
        out.push_str("</metadata>\n");
    }
    for w in &gpx.waypoints {
        point(out, "wpt", &w.point, w.name.as_deref(), "  ");
    }
    for r in &gpx.routes {
        out.push_str("  <rte>\n");
        if let Some(n) = &r.name {
            let _ = writeln!(out, "    <name>{}</name>", esc(n));
        }
        for p in r.segments.iter().flatten() {
            point(out, "rtept", p, None, "    ");
        }
        out.push_str("  </rte>\n");
    }
    for t in &gpx.tracks {
        out.push_str("  <trk>\n");
        if let Some(n) = &t.name {
            let _ = writeln!(out, "    <name>{}</name>", esc(n));
        }
        for seg in &t.segments {
            out.push_str("    <trkseg>\n");
            for p in seg {
                point(out, "trkpt", p, None, "      ");
            }
            out.push_str("    </trkseg>\n");
        }
        out.push_str("  </trk>\n");
    }
    out.push_str("</gpx>\n");
}
