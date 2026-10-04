import { invoke } from "@tauri-apps/api/core";
import type { Detail } from "./api";
import { dayKey } from "./format";

export interface WeatherSample {
  t: number;
  tempC: number | null;
  precipMm: number | null;
  windKmh: number | null;
  code: number | null;
}

const H = 3_600_000;

/** Kayıttan hava sorulacak noktalar: her `step` saatte bir (en çok 200). */
export function weatherPoints(d: Detail): { lat: number; lon: number; t: number }[] {
  const times = d.time;
  const first = times.find((t) => t != null);
  const last = [...times].reverse().find((t) => t != null);
  if (first == null || last == null) return [];
  const step = Math.max(H, Math.ceil((last - first) / 200 / H) * H);
  const out: { lat: number; lon: number; t: number }[] = [];
  let next = first;
  for (let i = 0; i < times.length; i++) {
    const t = times[i];
    if (t == null || t < next) continue;
    out.push({ lat: d.lat[i], lon: d.lon[i], t });
    next = t + step;
  }
  return out;
}

const cache = new Map<string, WeatherSample[]>();
export async function weatherFor(key: string, d: Detail): Promise<WeatherSample[]> {
  const hit = cache.get(key);
  if (hit) return hit;
  const pts = weatherPoints(d);
  if (!pts.length) throw new Error("Kayıtta zaman bilgisi yok");
  const w = await invoke<WeatherSample[]>("weather_at", { points: pts });
  cache.set(key, w);
  return w;
}

/** WMO hava kodu → simge ve Türkçe ad. */
export function weatherLabel(code: number | null): [string, string] {
  if (code == null) return ["·", "bilinmiyor"];
  if (code === 0) return ["☀️", "açık"];
  if (code <= 2) return ["🌤", "az bulutlu"];
  if (code === 3) return ["☁️", "kapalı"];
  if (code <= 48) return ["🌫", "sisli"];
  if (code <= 57) return ["🌦", "çisenti"];
  if (code <= 67) return ["🌧", "yağmurlu"];
  if (code <= 77) return ["🌨", "karlı"];
  if (code <= 82) return ["🌧", "sağanak"];
  if (code <= 86) return ["🌨", "kar sağanağı"];
  return ["⛈", "fırtına"];
}

export interface WeatherDay {
  day: string;
  min: number | null;
  max: number | null;
  precipMm: number;
  windMax: number | null;
  /** Günün en kötü (en yüksek) hava kodu. */
  code: number | null;
}

/** Örnekleri gün gün özetler (yağış, örnekler arası süreyle çarpılarak). */
export function weatherDays(w: WeatherSample[], tz: string | undefined): WeatherDay[] {
  const m = new Map<string, WeatherDay>();
  w.forEach((s, i) => {
    const day = dayKey(s.t, tz);
    const d = m.get(day) ?? { day, min: null, max: null, precipMm: 0, windMax: null, code: null };
    if (s.tempC != null) {
      d.min = d.min == null ? s.tempC : Math.min(d.min, s.tempC);
      d.max = d.max == null ? s.tempC : Math.max(d.max, s.tempC);
    }
    const hours = i + 1 < w.length ? Math.min(6, Math.max(1, (w[i + 1].t - s.t) / H)) : 1;
    d.precipMm += (s.precipMm ?? 0) * hours;
    if (s.windKmh != null) d.windMax = Math.max(d.windMax ?? 0, s.windKmh);
    if (s.code != null) d.code = Math.max(d.code ?? 0, s.code);
    m.set(day, d);
  });
  return [...m.values()];
}
