/** Uygulamayı tarayıcıda, Tauri yerine sahte bir arka uçla açar. Her test
 * `mock` ile komut yanıtlarını değiştirebilir. */
import { test as base, expect, type Page } from "@playwright/test";
import type { FileSummary } from "../src/api";
import { COMMUTES, detail, SUMMARIES } from "./fixtures";

type Handler = (args: Record<string, unknown>) => unknown;

export interface AppOptions {
  /** Klasik görünüm. */
  classic: boolean;
  /** İngilizce arayüz. */
  en: boolean;
  /** Kayıt sayısı: 0 yapay örnekler, fazlası `many(n)`. */
  records: number;
  /** Evden başlayan işe gidiş kayıtları da eklensin (gezi algılaması için). */
  commutes: boolean;
  /** Sayfanın saati (ISO); boşsa gerçek saat. */
  now: string;
}

/** Çok sayıda kayıt: örnekler ayrı aylara yayılır (gruplama, kaydırma). */
export function many(n: number): FileSummary[] {
  const out: FileSummary[] = [];
  for (let i = 0; i < n; i++) {
    const s = SUMMARIES[i % SUMMARIES.length];
    const shift = -Math.floor(i / SUMMARIES.length) * 9 * 86_400_000 - (i % SUMMARIES.length) * 3_600_000;
    const t0 = s.stats.startTime! + shift;
    out.push({
      ...s,
      path: s.path.replace(/\.gpx$/, `-${i}.gpx`),
      fileName: `${i}-${s.fileName}`,
      name: `${s.name} #${i}`,
      stats: { ...s.stats, startTime: t0, endTime: s.stats.endTime! + shift },
      times: s.times.map((l) => l.map((t) => (t == null ? t : t + shift))),
      visits: s.visits?.map(([t, cc, n]) => [t + shift, cc, n]),
    });
  }
  return out;
}

const DEFAULTS: Record<string, Handler> = {
  get_settings: () => ({
    stats: { movingSpeedMs: 0.5, elevationThresholdM: 3, cleanSpikes: true, perType: false, collapseStays: true },
    watchedFolders: [],
    syncFolder: null,
  }),
  sync_info: () => ({ folder: null, last: null }),
  set_settings: () => [],
  take_pending_paths: () => [],
  expand_paths: (a) => a.paths,
  get_meta: () => ({}),
  get_bookmarks: () => [],
  get_places: () => [],
  streets_info: () => [0, 0],
  search_trace: () => ["", []],
  get_journal: () => ({}),
  archive_info: () => ({ lastBackup: null, lastAutoBackup: null, lastCheck: null, lastVerify: null }),
  search_places_offline: () => [],
  search_streets_offline: () => [],
  search_places_online: () => [],
  "plugin:dialog|ask": () => true,
};

export const test = base.extend<AppOptions & { mock: Record<string, Handler>; app: Page; errors: string[] }>({
  classic: [false, { option: true }],
  en: [false, { option: true }],
  records: [0, { option: true }],
  commutes: [false, { option: true }],
  now: ["", { option: true }],
  mock: async ({}, use) => use({ ...DEFAULTS }),
  errors: async ({}, use) => use([]),
  app: async ({ page, classic, en, records, commutes, now, mock, errors }, use) => {
    if (now) await page.clock.setFixedTime(new Date(now));
    const summaries = [...(records ? many(records) : SUMMARIES), ...(commutes ? COMMUTES : [])];
    const byPath = new Map(summaries.map((s) => [s.path, s]));
    mock.library_files ??= () => summaries.map((s) => s.path);
    mock.load_files ??= (a) =>
      (a.paths as string[]).map((p) => (byPath.has(p) ? { status: "ok", file: byPath.get(p) } : { status: "error", path: p, message: "yok" }));
    mock.load_detail ??= (a) => detail(byPath.get(a.path as string)!);
    page.on("pageerror", (e) => errors.push(e.message));
    // Harita karoları ve dış servisler: ağ yok.
    await page.route(/^https?:\/\/(?!localhost)/, (r) => r.abort());
    await page.exposeFunction("__mock", async (cmd: string, args: Record<string, unknown>) => {
      const h = mock[cmd];
      return h ? h(args ?? {}) : null;
    });
    await page.addInitScript(
      ([c, e]) => {
        if (c) localStorage.setItem("gpxer.ui", "classic");
        if (e) localStorage.setItem("gpxer.lang", "en");
        let id = 0;
        const callbacks = new Map<number, (x: unknown) => void>();
        const listeners = new Map<string, number[]>();
        const w = window as unknown as Record<string, unknown>;
        w.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
          transformCallback: (cb: (x: unknown) => void) => {
            callbacks.set(++id, cb);
            return id;
          },
          unregisterCallback: (i: number) => callbacks.delete(i),
          invoke: (cmd: string, args: unknown) => {
            // Arka uç olayları: dinleyiciler kaydedilir, testler `__emit` ile tetikler.
            if (cmd === "plugin:event|listen") {
              const { event, handler } = args as { event: string; handler: number };
              listeners.set(event, [...(listeners.get(event) ?? []), handler]);
              return Promise.resolve(handler);
            }
            return (w.__mock as (c: string, a: unknown) => Promise<unknown>)(cmd, args ?? {});
          },
        };
        w.__emit = (event: string, payload: unknown) => listeners.get(event)?.forEach((h) => callbacks.get(h)?.({ event, id: h, payload }));
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
      },
      [classic, en] as const,
    );
    await page.goto("/");
    await page.locator(".file-row").first().waitFor({ state: "attached" });
    await use(page);
    expect(errors, "sayfa hatası").toEqual([]);
  },
});

export { expect };

/** Arka uçtan gelmiş gibi bir olay gönderir (`listen` dinleyicilerine). */
export const emit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as unknown as { __emit(e: string, p: unknown): void }).__emit(e, p), [event, payload] as const);

/** Gecikmeli yanıt (çevrimiçi aramayı taklit eder). */
export const later = <T>(ms: number, v: T) => new Promise<T>((r) => setTimeout(() => r(v), ms));
