//! Vektör karolarından (Mapbox Vector Tile, OpenMapTiles şeması) ad çıkarma:
//! caddeler ve sokaklar, mahalle/semt adları, mekânlar ve zirveler. Yalnızca
//! adlar ve birer temsilî nokta okunur; çizim için değil, arama içindir.

use std::io::Read;

/// Karodan çıkarılan adlı öğe.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Named {
    pub name: String,
    /// "street", "path", "suburb", "neighbourhood", "poi:school", "peak"…
    pub kind: String,
    pub lon: f64,
    pub lat: f64,
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Reader<'a> {
    fn new(b: &'a [u8]) -> Self {
        Reader { b, i: 0 }
    }
    fn done(&self) -> bool {
        self.i >= self.b.len()
    }
    fn varint(&mut self) -> Option<u64> {
        let mut v: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = *self.b.get(self.i)?;
            self.i += 1;
            v |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let n = self.varint()? as usize;
        let s = self.b.get(self.i..self.i.checked_add(n)?)?;
        self.i += n;
        Some(s)
    }
    /// Alan anahtarı: (alan numarası, tel türü).
    fn key(&mut self) -> Option<(u64, u64)> {
        let k = self.varint()?;
        Some((k >> 3, k & 7))
    }
    fn skip(&mut self, wire: u64) -> Option<()> {
        match wire {
            0 => {
                self.varint()?;
            }
            1 => self.i += 8,
            2 => {
                self.bytes()?;
            }
            5 => self.i += 4,
            _ => return None,
        }
        (self.i <= self.b.len()).then_some(())
    }
}

fn packed(b: &[u8]) -> Vec<u32> {
    let mut r = Reader::new(b);
    let mut out = Vec::new();
    while !r.done() {
        match r.varint() {
            Some(v) => out.push(v as u32),
            None => break,
        }
    }
    out
}

/// Value mesajından metin (sayıları da metne çevirir).
fn value_text(b: &[u8]) -> Option<String> {
    let mut r = Reader::new(b);
    while !r.done() {
        let (f, w) = r.key()?;
        match (f, w) {
            (1, 2) => return Some(String::from_utf8_lossy(r.bytes()?).into_owned()),
            (4..=6, 0) => return Some(r.varint()?.to_string()),
            _ => r.skip(w)?,
        }
    }
    None
}

/// Geometri komutlarından noktalar (karo koordinatı); çizgi/alan için orta nokta.
fn middle_point(geom: &[u32]) -> Option<(i64, i64)> {
    let mut pts = Vec::new();
    let (mut x, mut y) = (0i64, 0i64);
    let mut i = 0;
    let zz = |v: u32| ((v >> 1) as i64) ^ -((v & 1) as i64);
    while i < geom.len() {
        let cmd = geom[i] & 7;
        let count = (geom[i] >> 3) as usize;
        i += 1;
        match cmd {
            1 | 2 => {
                for _ in 0..count {
                    let (dx, dy) = (*geom.get(i)?, *geom.get(i + 1)?);
                    i += 2;
                    x += zz(dx);
                    y += zz(dy);
                    pts.push((x, y));
                }
            }
            7 => {}
            _ => return None,
        }
    }
    pts.get(pts.len() / 2).copied()
}

/// Karo koordinatından boylam/enlem.
fn to_lonlat(px: i64, py: i64, extent: f64, z: u32, x: u32, y: u32) -> (f64, f64) {
    let n = 2f64.powi(z as i32);
    let fx = (x as f64 + px as f64 / extent) / n;
    let fy = (y as f64 + py as f64 / extent) / n;
    let lon = fx * 360.0 - 180.0;
    let lat = (std::f64::consts::PI * (1.0 - 2.0 * fy))
        .sinh()
        .atan()
        .to_degrees();
    (lon, lat)
}

/// Bir katmandaki adlı öğeler.
fn layer_names(b: &[u8], z: u32, x: u32, y: u32, out: &mut Vec<Named>) -> Option<()> {
    let mut r = Reader::new(b);
    let mut name = String::new();
    let mut features: Vec<&[u8]> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    let mut values: Vec<Option<String>> = Vec::new();
    let mut extent = 4096.0;
    while !r.done() {
        let (f, w) = r.key()?;
        match (f, w) {
            (1, 2) => name = String::from_utf8_lossy(r.bytes()?).into_owned(),
            (2, 2) => features.push(r.bytes()?),
            (3, 2) => keys.push(String::from_utf8_lossy(r.bytes()?).into_owned()),
            (4, 2) => values.push(value_text(r.bytes()?)),
            (5, 0) => extent = r.varint()? as f64,
            _ => r.skip(w)?,
        }
    }
    let wanted = matches!(
        name.as_str(),
        "transportation_name" | "place" | "poi" | "mountain_peak"
    );
    if !wanted {
        return Some(());
    }
    let key_ix = |k: &str| keys.iter().position(|x| x == k);
    let (k_name, k_class, k_sub) = (key_ix("name"), key_ix("class"), key_ix("subclass"));
    for fb in features {
        let mut fr = Reader::new(fb);
        let (mut tags, mut geom) = (Vec::new(), Vec::new());
        while !fr.done() {
            let (f, w) = fr.key()?;
            match (f, w) {
                (2, 2) => tags = packed(fr.bytes()?),
                (4, 2) => geom = packed(fr.bytes()?),
                _ => fr.skip(w)?,
            }
        }
        let tag = |k: Option<usize>| -> Option<String> {
            let k = k? as u32;
            tags.as_chunks::<2>()
                .0
                .iter()
                .find(|p| p[0] == k)
                .and_then(|p| values.get(p[1] as usize)?.clone())
        };
        let Some(n) = tag(k_name).filter(|n| !n.trim().is_empty()) else {
            continue;
        };
        let class = tag(k_class).unwrap_or_default();
        let kind = match name.as_str() {
            "transportation_name" => match class.as_str() {
                "path" | "track" => "path".to_owned(),
                _ => "street".to_owned(),
            },
            "place" => match class.as_str() {
                // Şehir ve kasabalar zaten çevrimdışı yerleşim listesinde.
                // İlçe merkezleri (town) kalır: "Kadıköy" gibi yerler hem aranır
                // hem sokak aramasında konum olarak kullanılır.
                "city" | "country" | "state" | "province" | "continent" => continue,
                c => c.to_owned(),
            },
            "poi" => format!(
                "poi:{}",
                tag(k_sub).filter(|s| !s.is_empty()).unwrap_or(class)
            ),
            _ => "peak".to_owned(),
        };
        let Some((px, py)) = middle_point(&geom) else {
            continue;
        };
        let (lon, lat) = to_lonlat(px, py, extent, z, x, y);
        out.push(Named {
            name: n,
            kind,
            lon,
            lat,
        });
    }
    Some(())
}

/// Karodaki adlı öğeler (sıkıştırılmışsa açılır). Bozuk karoda boş liste.
pub(crate) fn names(bytes: &[u8], z: u32, x: u32, y: u32) -> Vec<Named> {
    let mut raw = Vec::new();
    let data: &[u8] = if bytes.starts_with(&[0x1f, 0x8b]) {
        if flate2::read::GzDecoder::new(bytes)
            .take(64 * 1024 * 1024)
            .read_to_end(&mut raw)
            .is_err()
        {
            return Vec::new();
        }
        &raw
    } else {
        bytes
    };
    let mut out = Vec::new();
    let mut r = Reader::new(data);
    while !r.done() {
        let Some((f, w)) = r.key() else { break };
        if f == 3 && w == 2 {
            let Some(layer) = r.bytes() else { break };
            let _ = layer_names(layer, z, x, y, &mut out);
        } else if r.skip(w).is_none() {
            break;
        }
    }
    out
}

/// Sıkıştırılmışsa açılmış karo baytları.
fn unzip(bytes: &[u8]) -> Option<std::borrow::Cow<'_, [u8]>> {
    if !bytes.starts_with(&[0x1f, 0x8b]) {
        return Some(std::borrow::Cow::Borrowed(bytes));
    }
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(64 * 1024 * 1024)
        .read_to_end(&mut raw)
        .ok()?;
    Some(std::borrow::Cow::Owned(raw))
}

/// Geometri komutlarından parçalar (her MoveTo yeni parça; karo koordinatı).
fn parts(geom: &[u32]) -> Vec<Vec<(i64, i64)>> {
    let mut out: Vec<Vec<(i64, i64)>> = Vec::new();
    let (mut x, mut y) = (0i64, 0i64);
    let mut i = 0;
    let zz = |v: u32| ((v >> 1) as i64) ^ -((v & 1) as i64);
    while i < geom.len() {
        let cmd = geom[i] & 7;
        let count = (geom[i] >> 3) as usize;
        i += 1;
        match cmd {
            1 | 2 => {
                for _ in 0..count {
                    let (Some(&dx), Some(&dy)) = (geom.get(i), geom.get(i + 1)) else {
                        return out;
                    };
                    i += 2;
                    x += zz(dx);
                    y += zz(dy);
                    if cmd == 1 || out.is_empty() {
                        out.push(Vec::new());
                    }
                    if let Some(p) = out.last_mut() {
                        p.push((x, y));
                    }
                }
            }
            7 => {}
            _ => return out,
        }
    }
    out
}

/// Adlı yol: (ad, çizgi parçaları [boylam, enlem]).
pub(crate) type Road = (String, Vec<Vec<(f64, f64)>>);

/// Konum bilgisi için karodan okunanlar: adlı yollar (tam çizgileriyle) ve
/// yer adları (mahalle, semt, ilçe merkezi…).
#[derive(Debug, Default)]
pub(crate) struct Locality {
    /// (ad, çizgi parçaları [boylam, enlem]).
    pub roads: Vec<Road>,
    /// (ad, sınıf, boylam, enlem): sınıf OpenMapTiles place sınıfı.
    pub places: Vec<(String, String, f64, f64)>,
}

/// Karodaki adlı yollar ve yer adları. Bozuk karoda boş.
pub(crate) fn locality(bytes: &[u8], z: u32, x: u32, y: u32) -> Locality {
    let mut out = Locality::default();
    let Some(data) = unzip(bytes) else {
        return out;
    };
    let mut r = Reader::new(&data);
    while !r.done() {
        let Some((f, w)) = r.key() else { break };
        if f == 3 && w == 2 {
            let Some(layer) = r.bytes() else { break };
            let _ = layer_locality(layer, z, x, y, &mut out);
        } else if r.skip(w).is_none() {
            break;
        }
    }
    out
}

fn layer_locality(b: &[u8], z: u32, x: u32, y: u32, out: &mut Locality) -> Option<()> {
    let mut r = Reader::new(b);
    let mut name = String::new();
    let mut features: Vec<&[u8]> = Vec::new();
    let mut keys: Vec<String> = Vec::new();
    let mut values: Vec<Option<String>> = Vec::new();
    let mut extent = 4096.0;
    while !r.done() {
        let (f, w) = r.key()?;
        match (f, w) {
            (1, 2) => name = String::from_utf8_lossy(r.bytes()?).into_owned(),
            (2, 2) => features.push(r.bytes()?),
            (3, 2) => keys.push(String::from_utf8_lossy(r.bytes()?).into_owned()),
            (4, 2) => values.push(value_text(r.bytes()?)),
            (5, 0) => extent = r.varint()? as f64,
            _ => r.skip(w)?,
        }
    }
    if name != "transportation_name" && name != "place" {
        return Some(());
    }
    let key_ix = |k: &str| keys.iter().position(|x| x == k);
    let (k_name, k_class) = (key_ix("name"), key_ix("class"));
    for fb in features {
        let mut fr = Reader::new(fb);
        let (mut tags, mut geom) = (Vec::new(), Vec::new());
        while !fr.done() {
            let (f, w) = fr.key()?;
            match (f, w) {
                (2, 2) => tags = packed(fr.bytes()?),
                (4, 2) => geom = packed(fr.bytes()?),
                _ => fr.skip(w)?,
            }
        }
        let tag = |k: Option<usize>| -> Option<String> {
            let k = k? as u32;
            tags.as_chunks::<2>()
                .0
                .iter()
                .find(|p| p[0] == k)
                .and_then(|p| values.get(p[1] as usize)?.clone())
        };
        let Some(n) = tag(k_name).filter(|n| !n.trim().is_empty()) else {
            continue;
        };
        let ll = |(px, py): (i64, i64)| to_lonlat(px, py, extent, z, x, y);
        if name == "place" {
            let Some(p) = parts(&geom).into_iter().flatten().next() else {
                continue;
            };
            let (lon, lat) = ll(p);
            out.places
                .push((n, tag(k_class).unwrap_or_default(), lon, lat));
        } else {
            let lines: Vec<Vec<(f64, f64)>> = parts(&geom)
                .into_iter()
                .map(|p| p.into_iter().map(ll).collect())
                .collect();
            out.roads.push((n, lines));
        }
    }
    Some(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn varint(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    fn field_bytes(f: u64, b: &[u8], out: &mut Vec<u8>) {
        varint((f << 3) | 2, out);
        varint(b.len() as u64, out);
        out.extend_from_slice(b);
    }
    fn packed_u32(v: &[u32]) -> Vec<u8> {
        let mut o = Vec::new();
        for &x in v {
            varint(x as u64, &mut o);
        }
        o
    }
    fn zz(v: i64) -> u32 {
        ((v << 1) ^ (v >> 63)) as u32
    }

    /// Deneme karosu: `layer` katmanında (ad, sınıf, çizgi noktaları) öğeleri.
    /// Deneme karosundaki öğe: (ad, sınıf, noktalar).
    pub(crate) type Item<'a> = (&'a str, &'a str, &'a [(i64, i64)]);

    pub(crate) fn tile(layer: &str, items: &[Item]) -> Vec<u8> {
        let mut l = Vec::new();
        varint((15 << 3) as u64, &mut l);
        varint(2, &mut l);
        field_bytes(1, layer.as_bytes(), &mut l);
        let mut keys = vec!["name", "class"];
        keys.dedup();
        let mut values: Vec<String> = Vec::new();
        for (name, class, pts) in items {
            let vi = |s: &str, values: &mut Vec<String>| -> u32 {
                if let Some(p) = values.iter().position(|x| x == s) {
                    return p as u32;
                }
                values.push(s.to_owned());
                (values.len() - 1) as u32
            };
            let tags = [0, vi(name, &mut values), 1, vi(class, &mut values)];
            let mut geom = Vec::new();
            let (mut cx, mut cy) = (0i64, 0i64);
            for (k, (x, y)) in pts.iter().enumerate() {
                if k == 0 {
                    geom.push((1 << 3) | 1);
                } else if k == 1 {
                    geom.push(((pts.len() as u32 - 1) << 3) | 2);
                }
                geom.push(zz(x - cx));
                geom.push(zz(y - cy));
                cx = *x;
                cy = *y;
            }
            let mut f = Vec::new();
            field_bytes(2, &packed_u32(&tags), &mut f);
            varint((3 << 3) as u64, &mut f);
            varint(if pts.len() > 1 { 2 } else { 1 }, &mut f);
            field_bytes(4, &packed_u32(&geom), &mut f);
            field_bytes(2, &f, &mut l);
        }
        for k in &keys {
            field_bytes(3, k.as_bytes(), &mut l);
        }
        for v in &values {
            let mut vb = Vec::new();
            field_bytes(1, v.as_bytes(), &mut vb);
            field_bytes(4, &vb, &mut l);
        }
        varint((5 << 3) as u64, &mut l);
        varint(4096, &mut l);
        let mut t = Vec::new();
        field_bytes(3, &l, &mut t);
        t
    }

    #[test]
    fn reads_street_names_from_tile() {
        // z14 karo: İstanbul Kadıköy civarı (x=9513, y=6144 → ~29.03, ~40.98).
        let t = tile(
            "transportation_name",
            &[
                (
                    "Bağdat Caddesi",
                    "secondary",
                    &[(100, 100), (2000, 2000), (4000, 4000)],
                ),
                ("Patika", "path", &[(10, 10), (20, 20)]),
            ],
        );
        let n = names(&t, 14, 9513, 6144);
        assert_eq!(n.len(), 2);
        assert_eq!(n[0].name, "Bağdat Caddesi");
        assert_eq!(n[0].kind, "street");
        assert_eq!(n[1].kind, "path");
        assert!((n[0].lon - 29.07).abs() < 0.05, "{:?}", n[0]);
        assert!((n[0].lat - 40.98).abs() < 0.05, "{:?}", n[0]);
        // Sıkıştırılmış karo da okunur.
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &t).unwrap();
        assert_eq!(names(&gz.finish().unwrap(), 14, 9513, 6144).len(), 2);
        // Başka katmanlar ve şehir adları atlanır; bozuk veri boş liste.
        assert!(names(
            &tile("water_name", &[("Marmara", "sea", &[(1, 1)])]),
            14,
            0,
            0
        )
        .is_empty());
        assert!(names(&tile("place", &[("İstanbul", "city", &[(1, 1)])]), 14, 0, 0).is_empty());
        assert_eq!(
            names(
                &tile("place", &[("Moda", "neighbourhood", &[(1, 1)])]),
                14,
                0,
                0
            )[0]
            .kind,
            "neighbourhood"
        );
        assert!(names(&[0xff, 0xff, 0xff], 14, 0, 0).is_empty());
    }

    #[test]
    fn reads_road_lines_and_places() {
        let t = tile(
            "transportation_name",
            &[("Fırın Sokak", "minor", &[(0, 0), (100, 0), (100, 100)])],
        );
        let l = locality(&t, 14, 9513, 6144);
        assert_eq!(l.roads.len(), 1);
        assert_eq!(l.roads[0].0, "Fırın Sokak");
        assert_eq!(l.roads[0].1[0].len(), 3);
        let p = tile("place", &[("Erenköy", "quarter", &[(10, 10)])]);
        let l = locality(&p, 14, 9513, 6144);
        assert_eq!(l.places[0].0, "Erenköy");
        assert_eq!(l.places[0].1, "quarter");
    }
}
