import { useCallback, useState } from "react";

export interface LoadError {
  path: string;
  message: string;
}

export interface Duplicate {
  path: string;
  /** Kütüphanedeki aynı içerikli dosyanın adı. */
  existing: string;
}

/** Bildirimler: kısa bilgi, hata listesi, kopya dosyalar. */
export function useNotices() {
  const [errors, setErrors] = useState<LoadError[]>([]);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const say = useCallback((msg: string) => {
    setInfo(msg);
    setTimeout(() => setInfo((m) => (m === msg ? null : m)), 5000);
  }, []);
  const fail = useCallback((message: string, path = "") => setErrors((prev) => [...prev, { path, message }]), []);
  return { errors, setErrors, duplicates, setDuplicates, info, setInfo, say, fail };
}
