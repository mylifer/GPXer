const nf0 = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "long",
  year: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const timestampFmt = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export const DASH = "—";

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

/** m/s → km/sa */
export function fmtSpeed(ms: number | null | undefined): string {
  if (ms == null) return DASH;
  return `${nf1.format(ms * 3.6)} km/sa`;
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

export function fmtDate(t: number | null | undefined): string {
  return t == null ? DASH : dateFmt.format(t);
}

export function fmtDateTime(t: number | null | undefined): string {
  return t == null ? DASH : dateTimeFmt.format(t);
}

export function fmtTimestamp(t: number | null | undefined): string {
  return t == null ? DASH : timestampFmt.format(t);
}

export function fmtTime(t: number | null | undefined): string {
  return t == null ? DASH : timeFmt.format(t);
}

export function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${nf1.format(b / 1024)} KB`;
  return `${nf1.format(b / 1024 / 1024)} MB`;
}
