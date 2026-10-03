import { useSyncExternalStore } from "react";

/**
 * İmleç konumu (grafik/harita üzerindeki nokta) için küçük dış depo: fare
 * hareketi ve oynatma her karede güncellenir; yalnızca bu değeri kullanan
 * bileşenler yeniden çizilir, uygulamanın tamamı değil.
 */
export interface IdxStore {
  get(): number | null;
  set(i: number | null): void;
  subscribe(fn: () => void): () => void;
}

export function createIdxStore(): IdxStore {
  let value: number | null = null;
  let notifying = false;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(i) {
      if (i === value) return;
      value = i;
      // Bildirim mikro görevde: efektlerin içinden yapılan sıfırlamalar (seçim
      // değişince) işlemeyle (commit) iç içe eşzamanlı güncelleme zinciri
      // oluşturmasın; ↑/↓ basılı tutulunca React'in güncelleme sınırına takılıyordu.
      if (notifying) return;
      notifying = true;
      queueMicrotask(() => {
        notifying = false;
        subs.forEach((fn) => fn());
      });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}

export const useIdx = (store: IdxStore) => useSyncExternalStore(store.subscribe, store.get);
