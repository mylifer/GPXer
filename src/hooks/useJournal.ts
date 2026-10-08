import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Günlük notları (gün → metin): yazdıkça kısa gecikmeyle kaydedilir. */
export function useJournal(fail: (m: string) => void) {
  const [days, setDays] = useState<Record<string, string>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** Henüz yazılmamış metinler (kapanışta gönderilir). */
  const pending = useRef(new Map<string, string>());
  const refresh = useCallback(
    () =>
      invoke<Record<string, string>>("get_journal")
        .then((d) => setDays(d ?? {}))
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
  // Kapanırken bekleyen yazımlar hemen gönderilir.
  useEffect(() => {
    const t = timers.current;
    const p = pending.current;
    return () => {
      for (const x of t.values()) clearTimeout(x);
      for (const [day, text] of p) void invoke("set_day_note", { day, text }).catch(() => {});
    };
  }, []);
  return { days, setDay, refresh };
}
