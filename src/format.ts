/**
 * Türkçe sayı/tarih biçimlendirme.
 *
 * Zamanlar ya bilgisayarın saat diliminde ya da kaydın yapıldığı yerin saat
 * diliminde gösterilir (Ayarlar). `tz` verilmeyen çağrılar bilgisayarın
 * saat dilimini kullanır.
 */

import { lang } from "./i18n";

/** Sayı ve tarih biçimlerinin dili (İngilizce arayüzde İngiliz biçimi: 1,234.5; 24 saat). */
export const LOCALE = lang === "en" ? "en-GB" : "tr-TR";
const EN = lang === "en";
/** Süre ve hız birimleri. */
const U = EN ? { d: "d", h: "h", m: "min", s: "s", kmh: "km/h" } : { d: "g", h: "sa", m: "dk", s: "sn", kmh: "km/sa" };

const nf0 = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const DASH = "—";

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
function dtf(kind: string, opts: Intl.DateTimeFormatOptions, tz?: string, locale = LOCALE) {
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
  // Yuvarlanınca 1000 olan (999,6 m) "1.000 m" yerine km olarak yazılır.
  if (Math.round(m) < 1000) return `${nf0.format(m)} m`;
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
  if (d > 0) return `${d} ${U.d} ${h} ${U.h} ${m} ${U.m}`;
  if (h > 0) return `${h} ${U.h} ${m} ${U.m}`;
  if (m > 0) return `${m} ${U.m} ${s} ${U.s}`;
  return `${s} ${U.s}`;
}

/** Dar yerler (liste satırı) için: bir günden uzun sürede dakika yazılmaz. */
export function fmtDurationShort(ms: number | null | undefined): string {
  if (ms != null && ms >= 86_400_000) {
    const h = Math.floor(ms / 3_600_000);
    return `${Math.floor(h / 24)} ${U.d} ${h % 24} ${U.h}`;
  }
  return fmtDuration(ms);
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
  return `${nf1.format(ms * 3.6)} ${U.kmh}`;
}

export function fmtKmh(v: number | null | undefined): string {
  return v == null ? DASH : `${nf1.format(v)} ${U.kmh}`;
}

export function fmtPace(ms: number | null | undefined): string {
  if (ms == null || ms <= 0) return DASH;
  const secPerKm = 1000 / ms;
  if (secPerKm > 3600) return DASH;
  // Önce toplam saniye yuvarlanır ("4:60" yerine "5:00").
  const total = Math.round(secPerKm);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")} /km`;
}

export function fmtElevation(m: number | null | undefined): string {
  if (m == null) return DASH;
  return `${nf0.format(m)} m`;
}

/** Arama için karşılaştırma biçimi: Türkçe küçük harf, ama ı/i ayrımı
 * yapılmaz ("IKEA", "Innsbruck" Türkçe kurallarla "ıkea" olup "ikea" ile
 * bulunamıyordu); macOS'un ayrıştırılmış (NFD) adları da birleştirilir. */
export const searchKey = (s: string) => s.normalize("NFC").toLocaleLowerCase("tr-TR").replace(/ı/g, "i");

export function fmtNumber(n: number): string {
  return nf0.format(n);
}

export function fmtDecimal(n: number | null | undefined, digits = 1): string {
  if (n == null) return "";
  return n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false });
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

/** Zamanın takvim günü "yyyy-aa-gg" biçiminde (filtre ve gruplama için).
 * Tek tük çağrılar için; sıcak döngülerde aynı sonucu veren `fastDayKey`. */
export function dayKey(t: number, tz?: string): string {
  // en-CA biçimi zaten yyyy-mm-dd verir.
  return dtf("key", { year: "numeric", month: "2-digit", day: "2-digit" }, tz, "en-CA").format(t);
}

/** `dayKey` ile aynı sonuç, önbellekli: saat dilimi farkları 15 dakikanın katı
 * olduğundan aynı çeyrek saat içindeki zamanlar aynı güne düşer; Intl çağrısı
 * çeyrek başına bir kez. Saatlik döküm ve iz noktaları gibi çok sayıda zaman için. */
const quarterCache = new Map<string, Map<number, string>>();
export function fastDayKey(t: number, tz: string | undefined): string {
  const ck = tz ?? "";
  let m = quarterCache.get(ck);
  if (!m) quarterCache.set(ck, (m = new Map()));
  const q = Math.floor(t / 900_000);
  let k = m.get(q);
  if (k === undefined) {
    k = dayKey(q * 900_000, tz);
    if (m.size > 500_000) m.clear();
    m.set(q, k);
  }
  return k;
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${nf1.format(b / 1024)} KB`;
  return `${nf1.format(b / 1024 / 1024)} MB`;
}

export const MONTHS = EN
  ? ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
  : ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];

/** "2025-03" → "Mart 2025" */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** "yyyy-aa-gg" ↔ "gg.aa.yyyy" */
/** İki yyyy-aa-gg gününün kısa aralığı; yıl, liste grubunun başlığında
 * olduğu için yalnızca aralık yıl değiştiriyorsa yazılır: "10–14.12",
 * "28.11–3.12", "30.12.23–2.01.24" (satırda mesafe ve süreye yer kalsın). */
export function dayRangeTr(a: string, b: string): string {
  const [ya, ma, da] = a.split("-");
  const [yb, mb, db] = b.split("-");
  const d = (x: string) => String(Number(x));
  if (ya !== yb) return `${d(da)}.${ma}.${ya.slice(2)}–${d(db)}.${mb}.${yb.slice(2)}`;
  if (ma !== mb) return `${d(da)}.${ma}–${d(db)}.${mb}`;
  return `${d(da)}–${d(db)}.${mb}`;
}

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

/** Koordinat, ondalık derece "41.012345, 28.976543" (Google Haritalar ve
 * çoğu uygulama bu biçimi doğrudan arar). */
export function fmtLatLon(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/** Koordinat, derece-dakika-saniye: 41°00'44.4"N 28°58'35.6"E. */
export function fmtLatLonDms(lat: number, lon: number): string {
  const part = (v: number, pos: string, neg: string) => {
    // Saniye 60,0'a yuvarlanmasın: önce onda bir saniyeye yuvarlanır.
    const tenths = Math.round(Math.abs(v) * 36000);
    const d = Math.floor(tenths / 36000);
    const m = Math.floor((tenths % 36000) / 600);
    const s = (tenths % 600) / 10;
    return `${d}°${String(m).padStart(2, "0")}'${s.toFixed(1).padStart(4, "0")}"${v < 0 ? neg : pos}`;
  };
  return `${part(lat, "N", "S")} ${part(lon, "E", "W")}`;
}
