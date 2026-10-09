import type { FileMeta } from "./api";
import { photoThumb } from "./api";
import { albumData, albumMonths, drawAlbumPage, monthsOf, PAGE_H, PAGE_W, type AlbumMonth } from "./album";
import { dedupedTotals } from "./days";
import { fmtDistance, fmtNumber, isoOf, isoToTr } from "./format";
import { t } from "./i18n";
import type { PlacedPhoto } from "./photos";
import { base64Bytes, bytesBase64, jpegPdf, type JpegPage } from "./pdf";
import { maskLines, type Zone } from "./privacy";
import { CARD_H, CARD_W, drawLines, drawYearCard, yearCardData } from "./shareCard";
import type { FileEntry } from "./types";

const QUALITY = 0.86;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

function page(canvas: HTMLCanvasElement): JpegPage {
  return { jpeg: base64Bytes(canvas.toDataURL("image/jpeg", QUALITY).split(",")[1]), width: canvas.width, height: canvas.height };
}

async function loadImage(src: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/** Koyu kapak zemini. */
function coverBackground(ctx: CanvasRenderingContext2D) {
  const g = ctx.createLinearGradient(0, 0, 0, PAGE_H);
  g.addColorStop(0, "#0f1b2d");
  g.addColorStop(1, "#13293d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
}

/** Kapak ve ay sayfalarından PDF (base64). */
async function render(
  cover: (ctx: CanvasRenderingContext2D) => void,
  months: AlbumMonth[],
  label: string,
  title: string,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext("2d")!;
  const pages: JpegPage[] = [];
  cover(ctx);
  ctx.textAlign = "left";
  pages.push(page(canvas));
  onProgress?.(1, months.length + 1);
  for (const [i, m] of months.entries()) {
    const thumbs = await Promise.all(
      m.photos.map(async (p) => {
        const url = await photoThumb(p).catch(() => null);
        return url ? loadImage(url) : null;
      }),
    );
    drawAlbumPage(ctx, label, m, thumbs, i + 2);
    pages.push(page(canvas));
    onProgress?.(i + 2, months.length + 1);
    // Arayüz donmasın: sayfalar arasında bir kare bekle.
    await new Promise((r) => setTimeout(r, 0));
  }
  return bytesBase64(jpegPdf(pages, undefined, title));
}

/** Yılın albümü: kapakta yıl kartı, ardından kayıtlı her ay için harita,
 * kayıtlar, günlük notları ve o ay çekilen fotoğraflar. PDF'in base64'ü. */
export async function buildAlbumPdf(
  files: FileEntry[],
  year: string,
  notes: Record<string, string>,
  meta: Record<string, FileMeta>,
  photos: readonly PlacedPhoto[],
  zones: Zone[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const months = albumData(files, year, notes, meta, photos, zones);
  const cover = (ctx: CanvasRenderingContext2D) => {
    const card = document.createElement("canvas");
    card.width = CARD_W;
    card.height = CARD_H;
    drawYearCard(card.getContext("2d")!, yearCardData(files, year, zones));
    coverBackground(ctx);
    const k = Math.min((PAGE_W - 120) / CARD_W, (PAGE_H - 260) / CARD_H);
    ctx.drawImage(card, (PAGE_W - CARD_W * k) / 2, 80, CARD_W * k, CARD_H * k);
    ctx.fillStyle = "#9fb3c8";
    ctx.font = `500 36px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(t(`${year} albümü`), PAGE_W / 2, PAGE_H - 90);
  };
  return render(cover, months, year, t(`${year} albümü`), onProgress);
}

/** Bir kişiyle yapılan bütün yolculukların albümü: kapakta birlikte gidilen
 * yerlerin haritası ve toplamlar, ardından birlikte olunan her ay. */
export async function buildPersonAlbumPdf(
  files: FileEntry[],
  person: string,
  notes: Record<string, string>,
  meta: Record<string, FileMeta>,
  photos: readonly PlacedPhoto[],
  zones: Zone[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const mine = files.filter((f) => meta[f.summary.path]?.people?.includes(person));
  const months = albumMonths(mine, monthsOf(mine), notes, meta, photos, zones);
  const sums = mine.map((f) => f.summary);
  const tot = dedupedTotals(sums, "", "");
  const days = monthsOf(mine);
  const first = sums.map((s) => s.stats.startTime).filter((x): x is number => x != null);
  const last = sums.map((s) => s.stats.endTime ?? s.stats.startTime).filter((x): x is number => x != null);
  const title = t(`${person} ile yolculuklar`);
  const cover = (ctx: CanvasRenderingContext2D) => {
    coverBackground(ctx);
    const M = 90;
    ctx.fillStyle = "#ffffff";
    ctx.font = `800 84px ${FONT}`;
    ctx.fillText(`👤 ${person}`, M, 190);
    ctx.fillStyle = "#9fb3c8";
    ctx.font = `500 40px ${FONT}`;
    ctx.fillText(t("ile yolculuklar"), M, 250);
    const box = { x: M, y: 310, w: PAGE_W - 2 * M, h: 860 };
    ctx.fillStyle = "rgba(255,255,255,0.04)";
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 24);
    ctx.fill();
    const lines = sums.flatMap((s) => s.lines.flatMap((l) => maskLines([l], zones).map((pts) => ({ activity: s.activity, pts }))));
    drawLines(ctx, lines, box, {
      radius: 24,
      pad: 40,
      halo: 0.18,
      colors: { walk: "#4fc3f7", run: "#ff6e6e", bike: "#8be36b", car: "#ffb347", unknown: "#c9a7ff" },
    });
    const facts: [string, string][] = [
      [t("Mesafe"), fmtDistance(tot.distanceM)],
      [t("Birlikte gün"), fmtNumber(tot.days)],
      [t("Kayıt"), fmtNumber(mine.length)],
    ];
    facts.forEach(([label, value], i) => {
      const x = M + i * ((PAGE_W - 2 * M) / 3);
      ctx.fillStyle = "#9fb3c8";
      ctx.font = `500 28px ${FONT}`;
      ctx.fillText(label, x, 1260);
      ctx.fillStyle = "#ffffff";
      ctx.font = `700 52px ${FONT}`;
      ctx.fillText(value, x, 1325);
    });
    if (first.length) {
      const a = isoOf(new Date(Math.min(...first)));
      const b = isoOf(new Date(Math.max(...last)));
      ctx.fillStyle = "#e8eef5";
      ctx.font = `500 32px ${FONT}`;
      ctx.fillText(`${isoToTr(a)} – ${isoToTr(b)} · ${t(`${fmtNumber(days.length)} ay`)}`, M, 1420);
    }
  };
  return render(cover, months, person, title, onProgress);
}
