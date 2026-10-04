import * as maplibregl from "maplibre-gl";
import type { Detail } from "../api";
import { fmtDistance, fmtTimestamp } from "../format";
import { EMPTY } from "./geojson";
import { setData } from "./context";
import { maskCanvas, type Zone } from "../privacy";

export interface VideoOptions {
  /** Videonun süresi (sn). */
  seconds: number;
  title: string;
  tz: string | undefined;
  color: string;
  padding: maplibregl.PaddingOptions;
  /** Gizlilik bölgeleri: karede örtülür. */
  zones: Zone[];
  onProgress(p: number): void;
  signal: AbortSignal;
}

/** Tarayıcının kaydedebildiği ilk biçim (WebKit MP4, Chromium WebM/MP4). */
export function videoMime(): string | null {
  // Tuvalden akış da gerekir (bazı WebKit sürümlerinde yok).
  if (typeof MediaRecorder === "undefined" || !("captureStream" in HTMLCanvasElement.prototype)) return null;
  const list = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

const FPS = 30;
const LAYERS = ["video-trail-casing", "video-trail", "video-head"];
/** Kayıt sonunda son karede beklenen süre (ms). */
const HOLD_MS = 1500;
/** İzde en çok bu kadar nokta çizilir (her karede yeniden çizildiği için). */
const MAX_TRAIL = 4000;

/** Seçili kaydı haritada baştan sona çizerek video kaydeder. Harita kaydın
 * tamamını gösterecek biçimde yerleştirilir; iz ilerledikçe çizilir, üstte ad,
 * zaman ve gidilen mesafe yazar. */
export async function recordTrip(map: maplibregl.Map, d: Detail, o: VideoOptions): Promise<Blob> {
  const mime = videoMime();
  if (!mime) throw new Error("Bu sistem video kaydını desteklemiyor");
  const n = d.lat.length;
  if (n < 2) throw new Error("Video için en az iki nokta gerekir");

  // İz seyreltilir; oynatma saati gerçek zamana göre (uzun duraklamalar kısaltılır).
  const step = Math.max(1, Math.ceil(n / MAX_TRAIL));
  const idx: number[] = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  const timed = d.time.every((t, i) => t != null && (i === 0 || t >= d.time[i - 1]!));
  const clock = [0];
  for (let k = 1; k < idx.length; k++) {
    const [a, b] = [idx[k - 1], idx[k]];
    const dt = timed ? d.time[b]! - d.time[a]! : (d.dist[b] - d.dist[a]) / 4.17;
    // Duraklamalar videoda en çok kısa bir an sürsün.
    const cap = timed ? 10 * 60_000 : Infinity;
    clock.push(clock[k - 1] + Math.min(Math.max(0, dt), cap));
  }
  const total = clock[clock.length - 1] || 1;
  const coords = idx.map((i) => [d.lon[i], d.lat[i]] as [number, number]);

  const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
  map.fitBounds(bounds, { padding: o.padding, duration: 0, maxZoom: 15 });
  let rec: MediaRecorder | null = null;
  let stopped: Promise<void> = Promise.resolve();
  const chunks: Blob[] = [];
  const onRender = () => overlay();
  // Kurulumda bir adım hata verse de katmanlar ve dinleyici geri alınır.
  const cleanup = () => {
    map.off("render", onRender);
    for (const id of LAYERS) map.setLayoutProperty(id, "visibility", "none");
    setData(map, "video-trail", EMPTY);
    setData(map, "video-head", EMPTY);
  };
  let overlay = () => {};
  try {
    map.setPaintProperty("video-trail", "line-color", o.color);
    map.setPaintProperty("video-head", "circle-color", o.color);
    for (const id of LAYERS) map.setLayoutProperty(id, "visibility", "visible");
    setData(map, "video-trail", EMPTY);
    setData(map, "video-head", EMPTY);
    await new Promise<void>((r) => {
      map.once("idle", () => r());
      map.triggerRepaint();
    });

    const src = map.getCanvas();
    const out = document.createElement("canvas");
    // Kodlayıcılar çift boyut ister.
    out.width = src.width - (src.width % 2);
    out.height = src.height - (src.height % 2);
    const ctx = out.getContext("2d")!;
    const scale = out.width / src.clientWidth || 1;
    let k = 0;
    overlay = () => {
      ctx.drawImage(src, 0, 0);
      maskCanvas(ctx, (p) => map.project(p), o.zones, scale);
      const i = idx[k];
      const pad = 14 * scale;
      ctx.font = `600 ${16 * scale}px system-ui, sans-serif`;
      const line1 = o.title;
      const line2 = `${d.time[i] != null ? fmtTimestamp(d.time[i], o.tz) + " · " : ""}${fmtDistance(d.dist[i])}`;
      const w = Math.max(ctx.measureText(line1).width, ctx.measureText(line2).width) + 2 * pad;
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillRect(pad, pad, w, 52 * scale);
      ctx.fillStyle = "#1d2327";
      ctx.fillText(line1, 2 * pad, pad + 22 * scale);
      ctx.font = `${14 * scale}px system-ui, sans-serif`;
      ctx.fillText(line2, 2 * pad, pad + 42 * scale);
      ctx.font = `${11 * scale}px system-ui, sans-serif`;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillText("GPXer", out.width - 50 * scale, out.height - 8 * scale);
    };
    map.on("render", onRender);

    const stream = out.captureStream(FPS);
    const r = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: 6_000_000,
    });
    rec = r;
    r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    // Kodlayıcı hata verirse de beklenen durma gelir (takılı kalmasın).
    stopped = new Promise<void>((res) => {
      r.onstop = () => res();
      r.onerror = () => res();
    });
    r.start(1000);

    const dur = o.seconds * 1000;
    const t0 = performance.now();
    await new Promise<void>((resolve, reject) => {
      const frame = (now: number) => {
        if (o.signal.aborted) return reject(new DOMException("İptal edildi", "AbortError"));
        const p = Math.min(1, (now - t0) / dur);
        const v = p * total;
        while (k < idx.length - 1 && clock[k + 1] <= v) k++;
        setData(map, "video-trail", {
          type: "Feature",
          properties: {},
          geometry: { type: "LineString", coordinates: coords.slice(0, k + 1) },
        });
        setData(map, "video-head", {
          type: "Feature",
          properties: {},
          geometry: { type: "Point", coordinates: coords[k] },
        });
        map.triggerRepaint();
        o.onProgress(p);
        if (now - t0 >= dur + HOLD_MS) resolve();
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  } finally {
    if (rec && rec.state !== "inactive") rec.stop();
    await stopped;
    cleanup();
  }
  return new Blob(chunks, { type: mime.split(";")[0] });
}
