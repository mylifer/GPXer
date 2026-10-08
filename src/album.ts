import type { Activity, FileMeta } from "./api";
import { dayBuckets, dedupedTotals, rangeShare } from "./days";
import { MONTHS, dayKey, fmtDistance, fmtNumber, isoToTr, tzOf } from "./format";
import { t } from "./i18n";
import type { PlacedPhoto } from "./photos";
import { maskLines, type Zone } from "./privacy";
import { drawLines, linesInYear, type YearCard } from "./shareCard";
import type { FileEntry } from "./types";

/** Albüm sayfasındaki en fazla fotoğraf ve kayıt satırı. */
export const ALBUM_PHOTOS = 6;
const ALBUM_ROWS = 14;

export interface AlbumMonth {
  /** "2024-07" */
  key: string;
  month: number;
  distanceM: number;
  days: number;
  lines: YearCard["lines"];
  records: { day: string; name: string; distanceM: number; people: string[] }[];
  notes: { day: string; text: string }[];
  /** O ay çekilmiş fotoğraflardan, aya yayılarak seçilenlerin yolları. */
  photos: string[];
}

/** Yılın kayıtlı her ayı için albüm sayfasının verisi (gizlilik bölgeleri kırpılır). */
export function albumData(
  files: FileEntry[],
  year: string,
  notes: Record<string, string>,
  meta: Record<string, FileMeta>,
  photos: readonly PlacedPhoto[],
  zones: Zone[] = [],
): AlbumMonth[] {
  const out: AlbumMonth[] = [];
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, "0")}`;
    const from = `${key}-01`;
    const to = `${key}-31`;
    const inMonth = files.filter((f) => dayBuckets(f.summary).some((d) => d.day.startsWith(key)));
    if (!inMonth.length) continue;
    const sums = inMonth.map((f) => f.summary);
    const tot = dedupedTotals(sums, from, to);
    const records = sums
      .map((s) => ({
        day: dayBuckets(s).find((d) => d.day.startsWith(key))!.day,
        name: s.name || s.fileName,
        distanceM: rangeShare(s, from, to).distanceM,
        people: meta[s.path]?.people ?? [],
      }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    const monthNotes = Object.entries(notes)
      .filter(([d, text]) => d.startsWith(key) && text.trim())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, text]) => ({ day, text: text.trim() }));
    const tzByPath = new Map(sums.map((s) => [s.path, tzOf(s)]));
    const shots = photos
      .filter((p) => p.at != null && dayKey(p.at, (p.record && tzByPath.get(p.record)) || undefined).startsWith(key))
      .sort((a, b) => a.at! - b.at!);
    const step = shots.length / ALBUM_PHOTOS;
    const picked = shots.length <= ALBUM_PHOTOS ? shots : Array.from({ length: ALBUM_PHOTOS }, (_, i) => shots[Math.floor(i * step)]);
    out.push({
      key,
      month: m,
      distanceM: tot.distanceM,
      days: tot.days,
      lines: sums
        .flatMap((s) => linesInYear(s, key))
        .flatMap((l) => maskLines([l.pts], zones).map((pts) => ({ activity: l.activity, pts }))),
      records,
      notes: monthNotes,
      photos: picked.map((p) => p.path),
    });
  }
  return out;
}

export const PAGE_W = 1240;
export const PAGE_H = 1754;
const M = 90;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
/** Kâğıtta okunacak koyu tonlar. */
const INK: Record<Activity, string> = {
  walk: "#0277bd",
  run: "#c62828",
  bike: "#2e7d32",
  car: "#e65100",
  unknown: "#6a1b9a",
};

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n+/)) {
    let line = "";
    for (const w of para.split(" ")) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > width && line) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
  }
  if (out.length > max) {
    out.length = max;
    out[max - 1] = `${out[max - 1].replace(/\s*\S*$/, "")} …`;
  }
  return out;
}

/** Görüntüyü kutuyu dolduracak biçimde (kırparak) çizer. */
function cover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number) {
  const k = Math.max(w / img.width, h / img.height);
  const sw = w / k;
  const sh = h / k;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

/** Bir ayın albüm sayfası (A4, 150 dpi). */
export function drawAlbumPage(
  ctx: CanvasRenderingContext2D,
  year: string,
  m: AlbumMonth,
  thumbs: ((CanvasImageSource & { width: number; height: number }) | null)[],
  page: number,
) {
  const W = PAGE_W;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, PAGE_H);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = "#1d2327";
  ctx.font = `800 72px ${FONT}`;
  ctx.fillText(MONTHS[m.month - 1], M, 150);
  const mw = ctx.measureText(MONTHS[m.month - 1]).width;
  ctx.fillStyle = "#8a9097";
  ctx.font = `500 44px ${FONT}`;
  ctx.fillText(year, M + mw + 20, 150);
  ctx.font = `500 28px ${FONT}`;
  ctx.fillStyle = "#4a5056";
  ctx.fillText(t(`${fmtDistance(m.distanceM)} · ${fmtNumber(m.days)} gün · ${fmtNumber(m.records.length)} kayıt`), M, 200);

  // Harita
  const map = { x: M, y: 236, w: W - 2 * M, h: 560 };
  ctx.fillStyle = "#f3f1ec";
  ctx.beginPath();
  ctx.roundRect(map.x, map.y, map.w, map.h, 18);
  ctx.fill();
  drawLines(ctx, m.lines, map, { radius: 18, pad: 40, colors: INK, halo: 0.12, width: 3 });

  let y = map.y + map.h + 60;
  const bottom = PAGE_H - 90;
  const photoH = thumbs.some(Boolean) ? 2 * 230 + 20 : 0;
  const textBottom = bottom - (photoH ? photoH + 40 : 0);

  // Kayıtlar
  ctx.font = `600 26px ${FONT}`;
  ctx.fillStyle = "#1d2327";
  const rows = m.records.slice(0, ALBUM_ROWS);
  for (const r of rows) {
    if (y > textBottom - 10) break;
    ctx.font = `500 24px ${FONT}`;
    ctx.fillStyle = "#8a9097";
    ctx.fillText(isoToTr(r.day).slice(0, 5), M, y);
    ctx.fillStyle = "#1d2327";
    const who = r.people.length ? ` · ${r.people.join(", ")}` : "";
    const [name] = wrap(ctx, `${r.name}${who}`, W - 2 * M - 300, 1);
    ctx.fillText(name, M + 100, y);
    ctx.textAlign = "right";
    ctx.fillStyle = "#4a5056";
    ctx.fillText(fmtDistance(r.distanceM), W - M, y);
    ctx.textAlign = "left";
    y += 38;
  }
  if (m.records.length > rows.length && y <= textBottom) {
    ctx.fillStyle = "#8a9097";
    ctx.fillText(t(`… ve ${fmtNumber(m.records.length - rows.length)} kayıt daha`), M + 100, y);
    y += 38;
  }

  // Günlük notları
  if (m.notes.length && y < textBottom - 60) {
    y += 24;
    for (const n of m.notes) {
      if (y > textBottom - 40) break;
      ctx.font = `600 24px ${FONT}`;
      ctx.fillStyle = "#1f6f5c";
      ctx.fillText(isoToTr(n.day), M, y);
      ctx.font = `italic 400 24px ${FONT}`;
      ctx.fillStyle = "#33393f";
      const room = Math.max(1, Math.floor((textBottom - y) / 34));
      for (const l of wrap(ctx, n.text, W - 2 * M - 170, Math.min(4, room))) {
        ctx.fillText(l, M + 170, y);
        y += 34;
      }
      y += 10;
    }
  }

  // Fotoğraflar: 3 × 2
  if (photoH) {
    const gw = (W - 2 * M - 2 * 20) / 3;
    const top = bottom - photoH;
    thumbs.slice(0, ALBUM_PHOTOS).forEach((img, i) => {
      const x = M + (i % 3) * (gw + 20);
      const yy = top + Math.floor(i / 3) * 250;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, yy, gw, 230, 12);
      ctx.clip();
      if (img) cover(ctx, img, x, yy, gw, 230);
      else {
        ctx.fillStyle = "#f3f1ec";
        ctx.fillRect(x, yy, gw, 230);
      }
      ctx.restore();
    });
  }

  ctx.fillStyle = "#a0a6ac";
  ctx.font = `500 20px ${FONT}`;
  ctx.textAlign = "right";
  ctx.fillText(`GPXer · ${year} · ${page}`, W - M, PAGE_H - 40);
  ctx.textAlign = "left";
}
