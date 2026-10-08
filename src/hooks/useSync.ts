import { useCallback, useEffect, useRef } from "react";
import { getBookmarks, getPlaces, syncNow, type Bookmark, type LoadResult, type NamedPlace } from "../api";
import { fmtNumber } from "../format";
import { t } from "../i18n";
import type { FileEntry } from "../types";

/** Cihazlar arası eşitleme: klasör seçiliyse kendiliğinden, istenince elle. */
export function useSync({
  syncFolder,
  addResults,
  replaceSummary,
  forgetPaths,
  refreshMeta,
  setPlacesState,
  setMarks,
  refreshJournal,
  say,
  fail,
}: {
  syncFolder: string | null;
  addResults(results: LoadResult[]): FileEntry[];
  replaceSummary(r: LoadResult): void;
  forgetPaths(paths: string[]): void;
  refreshMeta(): Promise<void>;
  setPlacesState(p: NamedPlace[]): void;
  setMarks(b: Bookmark[]): void;
  refreshJournal(): void;
  say(msg: string): void;
  fail(message: string): void;
}) {
  const syncing = useRef(false);
  /** Eşitler ve sonucu ekrana uygular. `manual`: değişiklik yoksa da bildirilir. */
  const runSync = useCallback(
    async (manual: boolean) => {
      if (syncing.current) return;
      syncing.current = true;
      try {
        const r = await syncNow();
        addResults(r.added);
        for (const u of r.updated) replaceSummary(u);
        forgetPaths(r.removed);
        if (r.metaChanged) await refreshMeta();
        if (r.placesChanged)
          getPlaces()
            .then((p) => Array.isArray(p) && setPlacesState(p))
            .catch(() => {});
        if (r.journalChanged) refreshJournal();
        if (r.bookmarksChanged)
          getBookmarks()
            .then((b) => Array.isArray(b) && setMarks(b))
            .catch(() => {});
        const parts = [
          r.pulled && `${fmtNumber(r.pulled)} kayıt alındı`,
          r.pushed && `${fmtNumber(r.pushed)} kayıt gönderildi`,
          r.removedLocal && `${fmtNumber(r.removedLocal)} kayıt öbür cihazda silindiği için çöp kutusuna taşındı`,
          r.removedRemote && `${fmtNumber(r.removedRemote)} silme öbür cihazlara bildirildi`,
          (r.metaChanged || r.placesChanged || r.bookmarksChanged || r.journalChanged) && "etiket, not, yer, yer imleri ya da günlük güncellendi",
          r.waiting && `${fmtNumber(r.waiting)} dosya bulut klasörüne henüz inmedi (sonraki eşitlemede)`,
        ]
          .filter((x): x is string => !!x)
          .map(t);
        if (r.conflicts.length)
          fail(
            `Eşitleme: ${r.conflicts.length} kayıt iki cihazda aynı adla farklı içerikte; dokunulmadı (${r.conflicts.slice(0, 3).join(", ")}${r.conflicts.length > 3 ? "…" : ""}).`,
          );
        if (parts.length) say(`${t("Eşitleme:")} ${parts.join("; ")}.`);
        else if (manual) say("Eşitleme: her şey güncel.");
      } catch (e) {
        if (manual) fail(String(e));
        else console.warn("Eşitleme yapılamadı:", e);
      } finally {
        syncing.current = false;
      }
    },
    [addResults, replaceSummary, forgetPaths, refreshMeta, setPlacesState, setMarks, say, fail],
  );
  // Klasör seçiliyse açılıştan biraz sonra ve 15 dakikada bir kendiliğinden.
  const runSyncRef = useRef(runSync);
  runSyncRef.current = runSync;
  useEffect(() => {
    if (!syncFolder) return;
    const first = setTimeout(() => runSyncRef.current(false), 8000);
    const every = setInterval(() => runSyncRef.current(false), 15 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [syncFolder]);
  return runSync;
}
