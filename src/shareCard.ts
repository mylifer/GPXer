import type { Activity, FileSummary } from "./api";
import { t } from "./i18n";
import { dayBuckets, dedupedTotals, rangeShare } from "./days";
import { flightsOf, uniqueFlights } from "./flights";
import { dayKey, dayRangeTr, fastDayKey, fmtDistance, fmtDuration, fmtElevation, fmtNumber, tzOf } from "./format";
import { visitedPlaces } from "./summary";
import type { FileEntry } from "./types";
import { countryName } from "./visits";
import { maskLines, type Zone } from "./privacy";

/** Yıl kartında gösterilenler. */
export interface YearCard {
  year: string;
  distanceM: number;
  movingMs: number;
  gainM: number;
  days: number;
  records: number;
  flights: { count: number; distanceM: number };
  countries: { cc: string; days: number }[];
  cities: string[];
  longest: { name: string; distanceM: number; days: string } | null;
  /** Haritada çizilecek çizgiler `[boylam, enlem]` ve türleri. */
  lines: { activity: Activity; pts: [number, number][] }[];
}

/** Bir yılın kartı için toplamlar (kopyalar bir kez sayılır, Özet ile aynı). */
export function yearCardData(files: FileEntry[], year: string, zones: Zone[] = []): YearCard {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const inYear = files.filter((f) => dayBuckets(f.summary).some((d) => d.day.startsWith(year)));
  const sums = inYear.map((f) => f.summary);
  const t = dedupedTotals(sums, from, to);
  const fl = uniqueFlights(
    sums.flatMap((s) => flightsOf(s).filter((x) => dayKey(x.start, tzOf(s)).startsWith(year))),
  );
  const v = visitedPlaces(inYear, from, to).years.find((y) => y.year === year);
  let longest: YearCard["longest"] = null;
  let best = 0;
  for (const s of sums) {
    const d = rangeShare(s, from, to).distanceM;
    if (d > best) {
      best = d;
      const days = dayBuckets(s)
        .map((b) => b.day)
        .filter((d) => d.startsWith(year));
      longest = {
        name: s.name || s.fileName,
        distanceM: d,
        days: days.length ? dayRangeTr(days[0], days[days.length - 1]) : "",
      };
    }
  }
  return {
    year,
    distanceM: t.distanceM,
    movingMs: t.movingMs,
    gainM: t.gainM,
    days: t.days,
    records: inYear.length,
    flights: { count: fl.length, distanceM: fl.reduce((a, x) => a + x.distanceM, 0) },
    countries: v?.countries ?? [],
    cities: (v?.cities ?? []).slice(0, 6).map((c) => c.name),
    longest,
    lines: sums.flatMap((s) => linesInYear(s, year)).flatMap((l) => maskLines([l.pts], zones).map((pts) => ({ activity: l.activity, pts }))),
  };
}

/** Kaydın o yıla düşen çizgi parçaları (zamanı olmayan kayıt tümüyle). */
export function linesInYear(s: FileSummary, year: string): YearCard["lines"] {
  const zone = tzOf(s);
  const out: YearCard["lines"] = [];
  s.lines.forEach((line, i) => {
    const times = s.times[i];
    if (!times?.length) {
      out.push({ activity: s.activity, pts: line });
      return;
    }
    let cur: [number, number][] = [];
    line.forEach((p, j) => {
      const tm = times[j];
      if (tm == null || fastDayKey(tm, zone).startsWith(year)) cur.push(p);
      else if (cur.length) {
        out.push({ activity: s.activity, pts: cur });
        cur = [];
      }
    });
    if (cur.length) out.push({ activity: s.activity, pts: cur });
  });
  return out;
}

export const CARD_W = 1080;
export const CARD_H = 1350;

const COLORS: Record<Activity, string> = {
  walk: "#4fc3f7",
  run: "#ff6e6e",
  bike: "#8be36b",
  car: "#ffb347",
  unknown: "#c9a7ff",
};
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Web Mercator y (radyan değil, birim kare). */
const mercY = (lat: number) => {
  const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};

/** Metni genişliğe sığacak satırlara böler (en çok `max` satır). */
function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  if (out.length > max) {
    out.length = max;
    out[max - 1] = `${out[max - 1].replace(/\s*\S*$/, "")} …`;
  }
  return out;
}

/** Çizgileri kutuya sığdırarak (Web Mercator) çizer; altlık harita yok. */
export function drawLines(
  ctx: CanvasRenderingContext2D,
  lines: YearCard["lines"],
  box: { x: number; y: number; w: number; h: number },
  o: { radius: number; pad: number; colors: Record<Activity, string>; halo: number; width?: number },
) {
  const pts = lines.flatMap((l) => l.pts);
  if (!pts.length) return;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [lon, lat] of pts) {
    const x = (lon + 180) / 360;
    const y = mercY(lat);
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const pad = o.pad;
  const span = Math.max(x1 - x0, y1 - y0, 1e-5);
  const k = Math.min((box.w - 2 * pad) / Math.max(x1 - x0, span * 0.05), (box.h - 2 * pad) / Math.max(y1 - y0, span * 0.05));
  const ox = box.x + box.w / 2 - ((x0 + x1) / 2) * k;
  const oy = box.y + box.h / 2 - ((y0 + y1) / 2) * k;
  const w = o.width ?? 2.5;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, o.radius);
  ctx.clip();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const pass of [0, 1]) {
    for (const l of lines) {
      if (l.pts.length < 2) continue;
      ctx.strokeStyle = o.colors[l.activity] ?? o.colors.unknown;
      ctx.globalAlpha = pass ? 0.95 : o.halo;
      ctx.lineWidth = pass ? w : w * 3.6;
      ctx.beginPath();
      l.pts.forEach(([lon, lat], i) => {
        const x = ((lon + 180) / 360) * k + ox;
        const y = mercY(lat) * k + oy;
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
      });
      ctx.stroke();
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

/** Kartı çizer (1080 × 1350, sosyal medya dikey biçimi). */
export function drawYearCard(ctx: CanvasRenderingContext2D, c: YearCard) {
  const W = CARD_W;
  const H = CARD_H;
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#0f1b2d");
  g.addColorStop(1, "#13293d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const M = 64;

  // Başlık
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "alphabetic";
  ctx.font = `800 128px ${FONT}`;
  ctx.fillText(c.year, M, 170);
  const yw = ctx.measureText(c.year).width;
  ctx.font = `500 40px ${FONT}`;
  ctx.fillStyle = "#9fb3c8";
  ctx.fillText(t("yolculuklarım"), M + yw + 24, 166);

  // Harita
  const box = { x: M, y: 220, w: W - 2 * M, h: 470 };
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 24);
  ctx.fill();
  if (c.lines.some((l) => l.pts.length)) {
    drawLines(ctx, c.lines, box, { radius: 24, pad: 36, colors: COLORS, halo: 0.18 });
  } else {
    ctx.fillStyle = "#6b819a";
    ctx.font = `500 32px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(t("Bu yıl kayıt yok"), W / 2, box.y + box.h / 2);
    ctx.textAlign = "left";
  }

  // Sayılar
  const tiles: [string, string][] = [
    [t("Mesafe"), fmtDistance(c.distanceM)],
    [t("Hareket süresi"), fmtDuration(c.movingMs)],
    [t("Etkin gün"), fmtNumber(c.days)],
    [t("Kayıt"), fmtNumber(c.records)],
    [t("Tırmanış"), fmtElevation(c.gainM)],
    [t("Uçuş"), c.flights.count ? `${fmtNumber(c.flights.count)} · ${fmtDistance(c.flights.distanceM)}` : "—"],
  ];
  const tw = (W - 2 * M) / 3;
  tiles.forEach(([label, value], i) => {
    const x = M + (i % 3) * tw;
    const y = 760 + Math.floor(i / 3) * 112;
    ctx.fillStyle = "#9fb3c8";
    ctx.font = `500 26px ${FONT}`;
    ctx.fillText(label, x, y);
    ctx.fillStyle = "#ffffff";
    // Uzun değer sütuna sığana dek küçülür (sıkıştırılmış yazı okunmuyordu).
    let size = 44;
    do ctx.font = `700 ${size}px ${FONT}`;
    while (ctx.measureText(value).width > tw - 20 && (size -= 2) > 22);
    ctx.fillText(value, x, y + 52);
  });

  // Ülkeler, şehirler, en uzun yolculuk
  let y = 990;
  const line = (label: string, text: string, max: number) => {
    if (!text) return;
    ctx.fillStyle = "#9fb3c8";
    ctx.font = `600 26px ${FONT}`;
    ctx.fillText(label, M, y);
    ctx.fillStyle = "#e8eef5";
    ctx.font = `500 30px ${FONT}`;
    for (const l of wrap(ctx, text, W - 2 * M, max)) {
      y += 40;
      ctx.fillText(l, M, y);
    }
    y += 56;
  };
  line(
    c.countries.length === 1 ? t("Ülke") : t(`${fmtNumber(c.countries.length)} ülke`),
    c.countries.map((x) => countryName(x.cc)).join(" · "),
    2,
  );
  line(t("En çok bulunulan yerler"), c.cities.join(" · "), 1);
  if (c.longest)
    line(
      t("En uzun yolculuk"),
      `${fmtDistance(c.longest.distanceM)}${c.longest.days ? ` · ${c.longest.days}` : ""} · ${c.longest.name}`,
      2,
    );

  ctx.fillStyle = "#6b819a";
  ctx.font = `500 24px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText("GPXer", W - M, H - 40);
  ctx.textAlign = "left";
}
