import { describe, expect, it } from "vitest";
import { csvFor } from "./csv";
import { summary } from "./testing";
import type { FileEntry } from "./types";

const entry = (name: string, minEleM: number | null = null): FileEntry => ({
  summary: summary(`/k/${name.length}.gpx`, {
    name,
    stats: { startTime: Date.parse("2024-06-01T10:00:00Z"), distanceM: 12_345.6, minEleM, pointCount: 7 },
  }),
  color: "#000",
  visible: true,
});

/** İlk sütunu (ad) ve "En düşük (m)" sütununu döndürür. */
const cells = (csv: string) => {
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  const head = lines[0].split(";");
  const col = head.indexOf("En düşük (m)");
  return lines.slice(1).map((l) => {
    const c = l.split(";");
    return { name: c[0], minEle: c[col], dist: c[head.indexOf("Mesafe (km)")] };
  });
};

describe("csvFor", () => {
  it("BOM, noktalı virgül ve CRLF kullanır; ondalık virgül", () => {
    const csv = csvFor([entry("Yürüyüş")]);
    expect(csv.startsWith("﻿Ad;Dosya;")).toBe(true);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(cells(csv)[0]).toMatchObject({ name: "Yürüyüş", dist: "12,346" });
  });

  it("formül gibi başlayan metnin başına kesme işareti ekler", () => {
    const rows = cells(csvFor(["=SUM(A1)", "+90 dk", "-x", "@ev", "\tsekme"].map((n) => entry(n))));
    expect(rows.map((r) => r.name)).toEqual(["'=SUM(A1)", "'+90 dk", "'-x", "'@ev", "'\tsekme"]);
  });

  it("negatif sayılar olduğu gibi kalır", () => {
    const rows = cells(csvFor([entry("-12,5", -28), entry("-3", -4.4)]));
    expect(rows.map((r) => r.name)).toEqual(["-12,5", "-3"]);
    expect(rows.map((r) => r.minEle)).toEqual(["-28", "-4"]);
  });

  it("ayırıcı ya da tırnak içeren alanı tırnaklar", () => {
    const csv = csvFor([entry('a;b "c"')]);
    expect(csv).toContain('\r\n"a;b ""c""";');
  });
});
