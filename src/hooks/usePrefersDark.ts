import { useEffect, useState } from "react";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Sistem koyu temada mı? Panel renkleri de bu medya sorgusuna bağlı; tema
 * değişince yeniden çizilmesi gerekenler (takvim, grafik) bunu izler. */
export function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(DARK_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(DARK_QUERY);
    if (!mq) return;
    const on = () => setDark(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return dark;
}
