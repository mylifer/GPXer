import type { Detail, FileSummary } from "./api";
import { lang, t } from "./i18n";
import { dayBuckets } from "./days";
import {
  dayKey,
  dayRangeTr,
  fmtDate,
  fmtDistance,
  fmtDuration,
  fmtElevation,
  fmtSpeed,
  fmtTime,
  isoToTr,
  tzOf,
} from "./format";
import type { Night } from "./nights";

export interface StoryPhoto {
  name: string;
  time: number | null;
  /** data: adresi. */
  src: string;
}

export interface StoryInput {
  s: FileSummary;
  detail: Detail | null;
  /** Harita görüntüsü (PNG, base64). */
  mapPng: string | null;
  nights: Night[];
  photos: StoryPhoto[];
}

const esc = (x: string) => x.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Yükseklik profili (SVG). */
function profileSvg(d: Detail): string {
  const pts: [number, number][] = [];
  const n = d.dist.length;
  const step = Math.max(1, Math.floor(n / 600));
  for (let i = 0; i < n; i += step) {
    const e = d.ele[i];
    if (e != null) pts.push([d.dist[i], e]);
  }
  if (pts.length < 2) return "";
  const W = 800;
  const H = 180;
  const maxD = pts[pts.length - 1][0] || 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [, e] of pts) {
    lo = Math.min(lo, e);
    hi = Math.max(hi, e);
  }
  const span = Math.max(hi - lo, 10);
  const x = (v: number) => ((v / maxD) * W).toFixed(1);
  // Çizgi 20..H-24 arasında; alt ve üst yazılar çizginin dışında kalır.
  const y = (v: number) => (H - 24 - ((v - lo) / span) * (H - 44)).toFixed(1);
  const line = pts.map(([dd, e]) => `${x(dd)},${y(e)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" class="profile" role="img" aria-label="${t("Yükseklik profili")}">
<polygon points="0,${H - 20} ${line} ${W},${H - 20}" fill="#2f7d5d33"/><polyline points="${line}" fill="none" stroke="#2f7d5d" stroke-width="2"/>
<text x="4" y="14">${t("en yüksek")} ${esc(fmtElevation(hi))}</text><text x="4" y="${H - 5}">${t("en düşük")} ${esc(fmtElevation(lo))}</text>
<text x="${W - 4}" y="${H - 5}" text-anchor="end">${esc(fmtDistance(maxD))}</text></svg>`;
}

/** Kaydın paylaşılabilir tek sayfalık hikâyesi (dışa bağımlılığı olmayan HTML). */
export function storyHtml({ s, detail, mapPng, nights, photos }: StoryInput): string {
  const tz = tzOf(s);
  const st = s.stats;
  const title = s.name || s.fileName;
  const days = dayBuckets(s);
  const when = days.length ? (days.length > 1 ? `${isoToTr(days[0].day)} – ${isoToTr(days[days.length - 1].day)}` : isoToTr(days[0].day)) : "";
  const route = [s.startPlace, s.endPlace].filter(Boolean).join(" → ");
  const cards: [string, string][] = [
    [t("Mesafe"), fmtDistance(st.distanceM)],
    [t("Hareket süresi"), fmtDuration(st.movingMs)],
    [t("Toplam süre"), fmtDuration(st.durationMs)],
    [t("Ort. hız"), fmtSpeed(st.avgMovingSpeedMs)],
    [t("Tırmanış"), fmtElevation(st.elevationGainM)],
    [t("En yüksek"), fmtElevation(st.maxEleM)],
  ];
  const nightOn = (day: string) => nights.find((n) => dayKey(n.start, tz) === day);
  const dayRows = days
    .map((d, i) => {
      const n = nightOn(d.day);
      return `<tr><td>${t(`${i + 1}. gün`)}</td><td>${esc(isoToTr(d.day))}</td><td>${esc(fmtDistance(d.distanceM))}</td><td>${esc(
        fmtDuration(d.movingMs),
      )}</td><td>${n ? `🛏 ${esc(n.place || "")}` : ""}</td></tr>`;
    })
    .join("");
  const photoHtml = photos
    .map(
      (p) =>
        `<figure><img src="${p.src}" alt="${esc(p.name)}" loading="lazy"><figcaption>${
          p.time != null ? esc(`${fmtDate(p.time, tz)} ${fmtTime(p.time, tz).slice(0, 5)}`) : esc(p.name)
        }</figcaption></figure>`,
    )
    .join("");
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f6f5f2;--panel:#fff;--text:#1d2327;--muted:#6b7177;--accent:#2f7d5d;--border:#e0ddd5}
@media (prefers-color-scheme:dark){:root{--bg:#15191c;--panel:#1e2428;--text:#e6e8ea;--muted:#9aa1a8;--border:#2e353a}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 48px}
h1{font-size:2rem;margin:0 0 4px}h2{font-size:1.15rem;margin:32px 0 10px}
.sub{color:var(--muted);margin:0 0 20px}
.map{width:100%;border-radius:12px;border:1px solid var(--border);display:block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px 12px}
.card span{display:block;color:var(--muted);font-size:.8rem}.card strong{font-size:1.15rem}
table{width:100%;border-collapse:collapse;background:var(--panel);border-radius:10px;overflow:hidden}
td{padding:8px 10px;border-bottom:1px solid var(--border)}tr:last-child td{border-bottom:0}
.profile{width:100%;height:auto;background:var(--panel);border:1px solid var(--border);border-radius:10px}
.profile text{fill:var(--muted);font-size:12px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px}
figure{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:10px;overflow:hidden}
figure img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block}figcaption{padding:6px 10px;color:var(--muted);font-size:.85rem}
footer{margin-top:40px;color:var(--muted);font-size:.85rem;text-align:center}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="sub">${esc([when, route].filter(Boolean).join(" · "))}</p>
${mapPng ? `<img class="map" src="data:image/png;base64,${mapPng}" alt="${t("Yolculuğun haritası")}">` : ""}
<div class="cards">${cards.map(([k, v]) => `<div class="card"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("")}</div>
${days.length > 1 ? `<h2>${t("Gün gün")}</h2><table>${dayRows}</table>` : ""}
${detail ? (() => {
    const svg = profileSvg(detail);
    return svg ? `<h2>${t("Yükseklik")}</h2>${svg}` : "";
  })() : ""}
${photos.length ? `<h2>${t("Fotoğraflar")}</h2><div class="photos">${photoHtml}</div>` : ""}
<footer>${t("GPXer ile oluşturuldu")}${days.length ? ` · ${esc(dayRangeTr(days[0].day, days[days.length - 1].day))}` : ""}</footer>
</main></body></html>`;
}

