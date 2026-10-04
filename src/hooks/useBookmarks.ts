import { useCallback, useEffect, useState } from "react";
import { getBookmarks, setBookmarks, type Bookmark } from "../api";

/** Yer imleri: açılışta yüklenir, değişiklikler hemen kaydedilir. */
export function useBookmarks(fail: (m: string) => void) {
  const [marks, setMarks] = useState<Bookmark[]>([]);
  useEffect(() => {
    getBookmarks()
      .then((b) => Array.isArray(b) && setMarks(b))
      .catch(() => {});
  }, []);
  const save = useCallback(
    (next: Bookmark[]) => {
      setMarks(next);
      setBookmarks(next).catch((e) => fail(String(e)));
    },
    [fail],
  );
  const upsert = useCallback(
    (b: Bookmark) => save(marks.some((m) => m.id === b.id) ? marks.map((m) => (m.id === b.id ? b : m)) : [...marks, b]),
    [marks, save],
  );
  const remove = useCallback((id: string) => save(marks.filter((m) => m.id !== id)), [marks, save]);
  return { marks, setMarks, upsert, remove };
}
