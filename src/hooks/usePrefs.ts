import { useCallback, useEffect, useRef, useState } from "react";
import { loadPrefs, savePrefs, type Prefs } from "../prefs";
import { setTzMode } from "../format";
import { BASE_LAYERS, type BaseLayer } from "../map/style";

/** Arayüz tercihleri: durum, her çizimde güncel kopyası ve kaydeden `up`. */
export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  /** Kaydedilecek seçim: seçim her değiştiğinde App'i yeniden çizmemek için
   * durumda değil, burada tutulur (hızlı ↑/↓ basışlarında güncelleme zinciri oluşmasın). */
  const persistedSel = useRef(prefs.selected);
  const up = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch, selected: persistedSel.current };
      savePrefs(next);
      return next;
    });
  }, []);
  setTzMode(prefs.tzMode);
  return { prefs, prefsRef, persistedSel, up };
}

/** Harita altlığı (localStorage'da saklanır). */
export function useBaseLayer() {
  const [baseLayer, setBaseLayer] = useState<BaseLayer>(() => {
    try {
      const v = localStorage.getItem("baseLayer.v2") as BaseLayer | null;
      return v && BASE_LAYERS.some((l) => l.id === v) ? v : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("baseLayer.v2", baseLayer);
    } catch {
      /* önemli değil */
    }
  }, [baseLayer]);
  return [baseLayer, setBaseLayer] as const;
}
