import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FLUSH_EVENT } from "../prefs";

/** Günlük notları (gün → metin): yazdıkça kısa gecikmeyle kaydedilir. */
export function useJournal(fail: (m: string) => void) {
  const [days, setDays] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Henüz yazılmamış metinler (kapanışta gönderilir). */
  const pending = useRef(new Map<string, string>());
  const refresh = useCallback(
    () =>
      invoke<Record<string, string>>("get_journal")
        // Yazılmayı bekleyen günler (kullanıcı yazarken) eski hâliyle ezilmez.
        .then((d) =>
          setDays(() => {
            const next = { ...(d ?? {}) };
            for (const [day, text] of pending.current) {
              if (text.trim()) next[day] = text;
              else delete next[day];
            }
            return next;
          }),
        )
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const setDay = useCallback(
    (day: string, text: string) => {
      setDays((d) => {
        const next = { ...d };
        if (text.trim()) next[day] = text;
        else delete next[day];
        return next;
      });
      clearTimeout(timers.current.get(day));
      pending.current.set(day, text);
      timers.current.set(
        day,
        setTimeout(() => {
          timers.current.delete(day);
          pending.current.delete(day);
          invoke("set_day_note", { day, text }).catch((e) => fail(String(e)));
        }, 600),
      );
    },
    [fail],
  );
  // Kapanırken (pencere kapatma, güncelleme kurulumu) bekleyen yazımlar
  // hemen gönderilir.
  useEffect(() => {
    const t = timers.current;
    const p = pending.current;
    const flush = () => {
      for (const x of t.values()) clearTimeout(x);
      t.clear();
      for (const [day, text] of p) void invoke("set_day_note", { day, text }).catch(() => {});
      p.clear();
    };
    window.addEventListener(FLUSH_EVENT, flush);
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener(FLUSH_EVENT, flush);
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  return { days, setDay, refresh };
}
