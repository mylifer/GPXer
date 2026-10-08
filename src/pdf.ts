/** Her sayfası tek bir JPEG görüntü olan en küçük PDF (1.4). Albüm gibi
 * tuvalde çizilmiş sayfalar için yeterli; kütüphane gerektirmez. */

export interface JpegPage {
  /** JPEG baytları (DCTDecode ile olduğu gibi gömülür). */
  jpeg: Uint8Array;
  /** Görüntünün piksel boyutu. */
  width: number;
  height: number;
}

/** A4, punto cinsinden. */
export const A4: [number, number] = [595.28, 841.89];

export function jpegPdf(pages: JpegPage[], [pw, ph]: [number, number] = A4, title = ""): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const put = (x: string | Uint8Array) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    chunks.push(b);
    size += b.length;
  };
  const obj = (n: number, body: string | (() => void)) => {
    offsets[n] = size;
    put(`${n} 0 obj\n`);
    if (typeof body === "string") put(body);
    else body();
    put("\nendobj\n");
  };
  // Nesneler: 1 katalog, 2 sayfa ağacı, 3 bilgi; her sayfa için sayfa,
  // içerik ve görüntü.
  const first = 4;
  const kids = pages.map((_, i) => `${first + i * 3} 0 R`).join(" ");
  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
  obj(3, `<< /Producer (GPXer) /Title <${utf16Hex(title)}> >>`);
  pages.forEach((p, i) => {
    const n = first + i * 3;
    // Görüntü sayfaya oranı korunarak sığdırılır ve ortalanır.
    const k = Math.min(pw / p.width, ph / p.height);
    const w = p.width * k;
    const h = p.height * k;
    const draw = `q ${f(w)} 0 0 ${f(h)} ${f((pw - w) / 2)} ${f((ph - h) / 2)} cm /Im Do Q`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(pw)} ${f(ph)}] /Resources << /XObject << /Im ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
    obj(n + 2, () => {
      put(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      put(p.jpeg);
      put("\nendstream");
    });
  });
  const count = first + pages.length * 3;
  const xref = size;
  put(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let i = 1; i < count; i++) put(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  put(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const f = (n: number) => String(Math.round(n * 100) / 100);

/** PDF metin dizesi: UTF-16BE (BOM ile) onaltılık. */
function utf16Hex(s: string): string {
  let h = "FEFF";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return h;
}

/** Base64 (veri URL'sinin virgülden sonrası) → bayt. */
export function base64Bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bayt → base64 (büyük dizilerde yığın taşmasın diye parça parça). */
export function bytesBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
