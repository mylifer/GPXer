/**
 * Türkçe sayı/tarih biçimlendirme.
 *
 * Zamanlar ya bilgisayarın saat diliminde ya da kaydın yapıldığı yerin saat
 * diliminde gösterilir (Ayarlar). `tz` verilmeyen çağrılar bilgisayarın
 * saat dilimini kullanır.
 */

const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const DASH = "—";

export type TzMode = "local" | "record";
let tzMode: TzMode = "local";

export function setTzMode(m: TzMode) {
  tzMode = m;
}

/** Kaydın saatleri hangi saat diliminde gösterilecek. */
export function tzOf(s: { timeZone: string | null } | null | undefined): string | undefined {
  return tzMode === "record" ? (s?.timeZone ?? undefined) : undefined;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(kind: string, opts: Intl.DateTimeFormatOptions, tz?: string, locale = "tr-TR") {
  const key = `${kind}|${tz ?? ""}|${locale}`;
  let f = fmtCache.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: tz });
    } catch {
      // Tanınmayan saat dilimi: bilgisayarınki kullanılır.
      f = new Intl.DateTimeFormat(locale, opts);
    }
    fmtCache.set(key, f);
  }
  return f;
}

const DATE: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
const DATE_TIME: Intl.DateTimeFormatOptions = {
  day: "numeric",
  month: "long",
  year: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
};
const TIMESTAMP: Intl.DateTimeFormatOptions = {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};
const TIME: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", second: "2-digit" };

export function fmtDistance(m: number | null | undefined): string {
  if (m == null) return DASH;
  if (m < 1000) return `${nf0.format(m)} m`;
  if (m < 100_000) return `${nf2.format(m / 1000)} km`;
  return `${nf1.format(m / 1000)} km`;
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  const total = Math.round(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d} g ${h} sa ${m} dk`;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk ${s} sn`;
  return `${s} sn`;
}

/** Süreyi s:dd:ss biçiminde verir (CSV için). */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null) return "";
  const t = Math.round(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** m/s → km/sa */
export function fmtSpeed(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  return `${nf1.format(ms * 3.6)} km/sa`;
}

export function fmtKmh(v: number | null | undefined): string {
  return v == null ? DASH : `${nf1.format(v)} km/sa`;
}

export function fmtPace(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return DASH;
  const secPerKm = 1000 / ms;
  if (secPerKm > 3600) return DASH;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

export function fmtElevation(m: number | null | undefined): string {
  if (m == null) return DASH;
  return `${nf0.format(m)} m`;
}

export function fmtNumber(n: number): string {
  return nf0.format(n);
}

export function fmtDecimal(n: number | null | undefined, digits = 1): string {
  if (n == null) return "";
  return n.toLocaleString("tr-TR", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
}

export function fmtUnit(v: number | null | undefined, unit: string, digits = 0): string {
  if (v == null) return DASH;
  return `${digits ? nf1.format(v) : nf0.format(v)} ${unit}`;
}

/** gg.aa.yyyy */
export function fmtDate(t: number | null | undefined, tz?: string): string {
  return t == null ? DASH : dtf("d", DATE, tz).format(t);
}

export function fmtDateTime(t: number | null | undefined, tz?: string): string {
  return t == null ? DASH : dtf("dt", DATE_TIME, tz).format(t);
}

/** gg.aa.yyyy ss:dd:sn */
export function fmtTimestamp(t: number | null | undefined, tz?: string): string {
  return t == null ? DASH : dtf("ts", TIMESTAMP, tz).format(t);
}

export function fmtTime(t: number | null | undefined, tz?: string): string {
  return t == null ? DASH : dtf("t", TIME, tz).format(t);
}

/** Zamanın takvim günü "yyyy-aa-gg" biçiminde (filtre ve gruplama için). */
export function dayKey(t: number, tz?: string): string {
  // en-CA biçimi zaten yyyy-mm-dd verir.
  return dtf("key", { year: "numeric", month: "2-digit", day: "2-digit" }, tz, "en-CA").format(t);
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${nf1.format(b / 1024)} KB`;
  return `${nf1.format(b / 1024 / 1024)} MB`;
}

export const MONTHS = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

/** "2025-03" → "Mart 2025" */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** "yyyy-aa-gg" ↔ "gg.aa.yyyy" */
export function isoToTr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

export function trToIso(tr: string): string | null {
  const m = /^\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s*$/.exec(tr);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function isoOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Saat diliminin `t` anındaki farkı (ms): yerel duvar saati = t + fark.
 * `tz` verilmezse bilgisayarın saat dilimi. */
export function tzOffsetMs(t: number, tz?: string | null): number {
  if (!tz) return -new Date(t).getTimezoneOffset() * 60_000;
  const f = dtf(
    "off",
    { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" },
    tz,
    "en-US",
  );
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(t)) if (x.type !== "literal") p[x.type] = Number(x.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second);
  return wall - Math.floor(t / 1000) * 1000;
}

/** UTC'ymiş gibi saklanan duvar saatini (ör. EXIF) gerçek ana çevirir. */
export function wallToUtc(wall: number, tz?: string | null): number {
  const guess = wall - tzOffsetMs(wall, tz);
  return wall - tzOffsetMs(guess, tz);
}

/** Gerçek anı o saat dilimindeki duvar saatine (UTC'ymiş gibi) çevirir. */
export const utcToWall = (t: number, tz?: string | null) => t + tzOffsetMs(t, tz);

/** "gg.aa.yyyy" ve "ss:dd" → duvar saati (UTC'ymiş gibi, ms); geçersizse null. */
export function parseTrWall(date: string, time: string): number | null {
  const iso = trToIso(date);
  const m = /^\s*(\d{1,2})[:.](\d{2})\s*$/.exec(time || "00:00");
  if (!iso || !m) return null;
  const [h, mi] = [Number(m[1]), Number(m[2])];
  if (h > 23 || mi > 59) return null;
  const [y, mo, d] = iso.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
}
