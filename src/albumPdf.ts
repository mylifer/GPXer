import type { FileMeta } from "./api";
import { photoThumb } from "./api";
import { albumData, drawAlbumPage, PAGE_H, PAGE_W } from "./album";
import { t } from "./i18n";
import type { PlacedPhoto } from "./photos";
import { base64Bytes, bytesBase64, jpegPdf, type JpegPage } from "./pdf";
import type { Zone } from "./privacy";
import { CARD_H, CARD_W, drawYearCard, yearCardData } from "./shareCard";
import type { FileEntry } from "./types";

const QUALITY = 0.86;

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
  const canvas = document.createElement("canvas");
  canvas.width = PAGE_W;
  canvas.height = PAGE_H;
  const ctx = canvas.getContext("2d")!;
  const pages: JpegPage[] = [];

  // Kapak: koyu zemin üzerinde yıl kartı.
  const card = document.createElement("canvas");
  card.width = CARD_W;
  card.height = CARD_H;
  drawYearCard(card.getContext("2d")!, yearCardData(files, year, zones));
  const g = ctx.createLinearGradient(0, 0, 0, PAGE_H);
  g.addColorStop(0, "#0f1b2d");
  g.addColorStop(1, "#13293d");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, PAGE_W, PAGE_H);
  const k = Math.min((PAGE_W - 120) / CARD_W, (PAGE_H - 260) / CARD_H);
  ctx.drawImage(card, (PAGE_W - CARD_W * k) / 2, 80, CARD_W * k, CARD_H * k);
  ctx.fillStyle = "#9fb3c8";
  ctx.font = "500 36px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(t(`${year} albümü`), PAGE_W / 2, PAGE_H - 90);
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
    drawAlbumPage(ctx, year, m, thumbs, i + 2);
    pages.push(page(canvas));
    onProgress?.(i + 2, months.length + 1);
    // Arayüz donmasın: sayfalar arasında bir kare bekle.
    await new Promise((r) => setTimeout(r, 0));
  }
  return bytesBase64(jpegPdf(pages, undefined, t(`${year} albümü`)));
}
