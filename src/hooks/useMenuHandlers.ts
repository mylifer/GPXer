import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/** Uygulama menüsünden gelen komutlar; işleyiciler her çizimde güncellenir,
 * dinleyici bir kez kurulur. */
export function useMenuHandlers(current: Record<string, () => void>) {
  const handlers = useRef<Record<string, () => void>>({});
  handlers.current = current;
  useEffect(() => {
    const u = listen<string>("menu", (e) => handlers.current[e.payload]?.());
    return () => {
      u.then((fn) => fn());
    };
  }, []);
}
