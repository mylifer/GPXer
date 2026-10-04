/** Harita bilgi kutularının HTML'i. */
import type { Detail, FileSummary } from "../api";
import { METRICS, type FileEntry } from "../types";
import type { PlacedPhoto } from "../photos";
import { fmtDate, fmtDistance, fmtDuration, fmtKmh, fmtNumber, fmtTime, fmtTimestamp, fmtUnit, tzOf } from "../format";
import { endName, type Flight } from "../flights";

export function gapPopupHtml(pr: Record<string, unknown>): string {
  const tz = tzOf({ timeZone: (pr.tz as string) || null });
  const start = Number(pr.start);
  const end = Number(pr.end);
  const when = start && end ? `<br>${fmtTimestamp(start, tz)} → ${fmtTimestamp(end, tz)} · ${fmtDuration(end - start)}` : "";
  return `<strong>Kayıt boşluğu</strong> · ${fmtDistance(Number(pr.dist))}${when}<br><span class="muted">Bu arada nokta kaydedilmemiş (uçuş, sinyal kaybı ya da kayıt durdurulmuş).</span>`;
}

export function flightPopupHtml(f: Flight, s: FileSummary | undefined): string {
  const tz = tzOf(s);
  return (
    `<strong>✈ ${escapeHtml(endName(f, "from"))} → ${escapeHtml(endName(f, "to"))}</strong><br>` +
    `<span class="popup-time">${fmtTimestamp(f.start, tz)}</span> · ${fmtDistance(f.distanceM)} · ${fmtDuration(f.durationMs)}` +
    (s ? `<br><span class="muted"><span data-no-i18n>${escapeHtml(s.name || s.fileName)}</span> · tıklayınca seçilir</span>` : "")
  );
}

export function stopPopupHtml(pr: Record<string, unknown>, kind: "stop" | "hot"): string {
  const name = pr.name ? `<strong>${escapeHtml(String(pr.name))}</strong> · ` : "";
  return kind === "stop"
    ? `${name}<strong>${pr.night ? "Konaklama" : "Duraklama"}</strong><br>${
        pr.night ? `${fmtDate(Number(pr.start), tzOf({ timeZone: (pr.tz as string) || null }))} ` : ""
      }${fmtTime(Number(pr.start), tzOf({ timeZone: (pr.tz as string) || null }))} · ${fmtDuration(Number(pr.dur))}`
    : `${name}<strong>Sık duraklanan yer</strong><br>${fmtNumber(Number(pr.n))} duraklama · ${fmtNumber(Number(pr.files))} kayıt<br>toplam ${fmtDuration(Number(pr.dur))}`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function detailPopupHtml(s: FileSummary, d: Detail, i: number): string {
  const tz = tzOf(s);
  const rows: string[] = [
    `<strong data-no-i18n>${escapeHtml(s.name || s.fileName)}</strong>`,
    `<span class="popup-time">${fmtTimestamp(d.time[i], tz)}</span>`,
    `${fmtDistance(d.dist[i])} · ${fmtUnit(d.ele[i], "m")} · ${fmtKmh(d.speed[i])}`,
  ];
  const extra: string[] = [];
  for (const m of ["hr", "cad", "power", "temp"] as const) {
    const v = d[m][i];
    if (v != null) extra.push(`${METRICS[m].label} ${fmtUnit(v, METRICS[m].unit, METRICS[m].digits)}`);
  }
  if (extra.length) rows.push(extra.join(" · "));
  return rows.join("<br>");
}

/** Seçili olmayan izin bilgi kutusu: imlecin altındaki an (varsa) ve uzunluk. */
export function trackPopupHtml(s: FileSummary, t: number | null, hits: number): string {
  return (
    `<strong data-no-i18n>${escapeHtml(s.name || s.fileName)}</strong><br>` +
    (t != null
      ? `<span class="popup-time">${fmtTimestamp(t, tzOf(s))}</span><br>${fmtDistance(s.stats.distanceM)}`
      : `${fmtDate(s.stats.startTime, tzOf(s))} · ${fmtDistance(s.stats.distanceM)}`) +
    (hits > 1 ? `<br><small>${hits} iz üst üste · tıklayıp seçin</small>` : "")
  );
}

/** Üst üste binen izlerden seçim penceresindeki bir satır. */
export function chooserItemHtml(f: FileEntry): string {
  const s = f.summary;
  return `<span class="swatch" style="background:${f.color}"></span><span><strong data-no-i18n>${escapeHtml(
    s.name || s.fileName,
  )}</strong><br><small>${fmtDate(s.stats.startTime, tzOf(s))} · ${fmtDistance(s.stats.distanceM)}</small></span>`;
}

/** Fotoğraf kutusundaki bilgi: ad, çekim zamanı, eşleşen kayıt, konumun kaynağı. */
export function photoInfoHtml(ph: PlacedPhoto, sum: FileSummary | undefined): string {
  return (
    `<strong data-no-i18n>${escapeHtml(ph.name)}</strong>` +
    (ph.at != null ? `<br><span class="popup-time">${fmtTimestamp(ph.at, tzOf(sum))}</span>` : "") +
    (sum ? `<br><span class="muted" data-no-i18n>${escapeHtml(sum.name || sum.fileName)}</span>` : "") +
    `<br><small class="muted">${ph.fromTrack ? "Konum izden (çekim zamanına göre)" : "Konum fotoğrafın GPS bilgisinden"}</small>`
  );
}

/** Fotoğraf işaretinin ipucu metni. */
export function photoTitle(group: PlacedPhoto[], sum: FileSummary | undefined): string {
  const first = group[0];
  return group.length > 1
    ? `${fmtNumber(group.length)} fotoğraf · tıklayınca yakınlaşır`
    : `${first.name}${first.at != null ? `\n${fmtTimestamp(first.at, tzOf(sum))}` : ""}${sum ? `\n${sum.name || sum.fileName}` : ""}`;
}
