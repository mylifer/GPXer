import { describe, expect, it } from "vitest";
import { base64Bytes, bytesBase64, jpegPdf } from "./pdf";

const text = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

describe("jpegPdf", () => {
  it("geçerli çapraz başvuru tablosu ve sayfa başına bir görüntü", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    const pdf = jpegPdf(
      [
        { jpeg, width: 100, height: 200 },
        { jpeg, width: 300, height: 200 },
      ],
      undefined,
      "2024 albümü",
    );
    const s = text(pdf);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s).toContain("/Count 2");
    expect(s.match(/\/Subtype \/Image/g)).toHaveLength(2);
    // startxref, "xref" satırının bayt konumunu göstermeli; her girdi kendi nesnesini.
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe("xref");
    const entries = s.slice(xref).split("\n").slice(3, 3 + 9);
    entries.forEach((e, i) => expect(s.slice(Number(e.slice(0, 10)), Number(e.slice(0, 10)) + 8)).toBe(`${i + 1} 0 obj`.padEnd(8, "\n").slice(0, 8)));
    expect(s).toContain("/Size 10");
  });
  it("base64 gidiş-dönüş", () => {
    const b = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64Bytes(bytesBase64(b))).toEqual(b);
  });
});
