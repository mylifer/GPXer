import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { FLUSH_EVENT } from "../prefs";

type State =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "error"; message: string };

/** Uygulama açıkken yeni sürümün ne sıklıkla denetleneceği. */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/** Açılışta, açıkken düzenli aralıklarla ve menüden istenince GitHub'daki son
 * sürümü denetler; yeni sürüm varsa indirip kurmayı önerir. */
export function UpdateNotice() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const busy = useRef(false);
  /** Kurulum sürerken denetim yapılmaz (durumu "var"a geri döndürüyordu). */
  const installing = useRef(false);
  /** "Sonra" denilen sürüm kendiliğinden yapılan denetimlerde yeniden önerilmez. */
  const dismissed = useRef<string | null>(null);

  const run = useCallback(async (manual: boolean) => {
    if (busy.current || installing.current) return;
    // Öneri zaten ekrandaysa kendiliğinden denetim gerekmez.
    if (!manual && stateRef.current.kind === "available") return;
    busy.current = true;
    if (manual) setState({ kind: "checking" });
    try {
      const update = await check();
      if (installing.current) return;
      const prev = stateRef.current.kind === "available" ? stateRef.current.update : null;
      if (update && (manual || update.version !== dismissed.current)) {
        // Eskisinin kaynağı bırakılır (her denetimde yenisi oluşuyordu).
        if (prev && prev !== update) void prev.close().catch(() => {});
        setState({ kind: "available", update });
      } else {
        if (update) void update.close().catch(() => {});
        if (manual) setState({ kind: "current" });
      }
    } catch (e) {
      // Kendiliğinden yapılan denetim sessizce başarısız olabilir (ör. internet yok).
      if (manual) setState({ kind: "error", message: String(e) });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (import.meta.env.PROD) {
      run(false);
      timer = setInterval(() => run(false), CHECK_INTERVAL_MS);
    }
    const unlisten = listen<string>("menu", (e) => {
      if (e.payload === "check_updates") run(true);
    });
    return () => {
      clearInterval(timer);
      unlisten.then((fn) => fn());
    };
  }, [run]);

  useEffect(() => {
    if (state.kind !== "current") return;
    const t = setTimeout(() => setState({ kind: "idle" }), 4000);
    return () => clearTimeout(t);
  }, [state]);

  const install = async (update: Update) => {
    if (installing.current) return;
    installing.current = true;
    // Uygulama kurulumla birlikte kapanır: bekleyen tercihler ve not şimdi
    // yazılır (kapanış olayları güncellemede çalışmayabiliyor).
    window.dispatchEvent(new Event(FLUSH_EVENT));
    await new Promise((r) => setTimeout(r, 300));
    let total = 0;
    let done = 0;
    setState({ kind: "downloading", version: update.version, percent: null });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          if (total > 0) {
            setState({ kind: "downloading", version: update.version, percent: Math.round((done / total) * 100) });
          }
        }
      });
      // Windows'ta kurulum programı uygulamayı kendisi kapatır; macOS'ta
      // yeni sürümü açmak için yeniden başlatıyoruz.
      await relaunch();
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    } finally {
      installing.current = false;
    }
  };

  const close = () => {
    const s = stateRef.current;
    if (s.kind === "available") dismissed.current = s.update.version;
    setState({ kind: "idle" });
  };

  switch (state.kind) {
    case "idle":
      return null;
    case "checking":
      return <div className="toast update">Güncellemeler denetleniyor…</div>;
    case "current":
      return <div className="toast update">GPXer güncel.</div>;
    case "available":
      return (
        <div className="toast update">
          <div className="toast-head">
            <strong>GPXer {state.update.version} yayımlandı</strong>
            <button className="icon-btn" onClick={close} title="Sonra">
              ×
            </button>
          </div>
          <div className="update-actions">
            <button className="btn small primary" onClick={() => install(state.update)}>
              Güncelle ve yeniden başlat
            </button>
            <button className="btn small" onClick={close}>
              Sonra
            </button>
          </div>
        </div>
      );
    case "downloading":
      return (
        <div className="toast update">
          <div className="progress" aria-live="polite">
            <div className="progress-bar" style={{ width: `${state.percent ?? 0}%` }} />
            <span>
              GPXer {state.version} indiriliyor{state.percent != null ? ` (%${state.percent})` : "…"}
            </span>
          </div>
        </div>
      );
    case "error":
      return (
        <div className="toast update error">
          <div className="toast-head">
            <strong>Güncelleme yapılamadı</strong>
            <button className="icon-btn" onClick={close} title="Kapat">
              ×
            </button>
          </div>
          <div>{state.message}</div>
        </div>
      );
  }
}
