import { useCallback, type Dispatch, type SetStateAction } from "react";
import { mergeFiles, splitFile, trimFile, type Detail, type LoadResult } from "../api";
import type { FileEntry } from "../types";
import type { SetDialog } from "./dialog";

/** İz düzenleme: kırpma, bölme, birleştirme (yeni kayıt oluşturur, orijinal kalır). */
export function useTrackEdits({
  selected,
  detail,
  range,
  multi,
  setMulti,
  setDialog,
  addResults,
  pick,
  say,
  fail,
  refreshMeta,
}: {
  selected: string | null;
  detail: Detail | null;
  range: [number, number] | null;
  multi: Set<string>;
  setMulti: Dispatch<SetStateAction<Set<string>>>;
  setDialog: SetDialog;
  addResults(results: LoadResult[]): FileEntry[];
  pick(path: string | null): void;
  say(msg: string): void;
  fail(message: string): void;
  /** Yeni kayda arka uçta taşınan etiket ve türü arayüze de getirir (yoksa
   * görünmüyor, ilk düzenlemede de siliniyordu). */
  refreshMeta(): Promise<void>;
}) {
  const trim = useCallback(async () => {
    if (!selected || !detail || !range) return;
    try {
      const added = addResults([await trimFile(selected, detail.idx[range[0]], detail.idx[range[1]])]);
      await refreshMeta();
      if (added[0]) pick(added[0].summary.path);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, detail, range, addResults, fail, pick, refreshMeta]);

  const split = useCallback(async () => {
    if (!selected || !detail || !range) return;
    try {
      const added = addResults(await splitFile(selected, detail.idx[range[0]]));
      await refreshMeta();
      if (added.length === 2) say("Kayıt ikiye bölündü; iki yeni kayıt eklendi (orijinal duruyor).");
      if (added[1]) pick(added[1].summary.path);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, detail, range, addResults, fail, say, pick, refreshMeta]);

  const merge = useCallback(
    async (name: string) => {
      setDialog(null);
      // Seçilenlerin tümü birleştirilir; bu arada süzgeçle gizlenenler de
      // (yalnızca görünenler alınıyordu). Sıra arka uçta zamana göre.
      const paths = [...multi];
      if (paths.length < 2) {
        say("Birleştirmek için en az iki kayıt seçin.");
        return;
      }
      try {
        const added = addResults([await mergeFiles(paths, name)]);
        await refreshMeta();
        if (added[0]) {
          setMulti(new Set());
          pick(added[0].summary.path);
          say(`${paths.length} kayıt birleştirildi (orijinaller duruyor).`);
        }
      } catch (e) {
        fail(String(e));
      }
    },
    [multi, addResults, say, fail, pick, refreshMeta],
  );

  const openMerge = useCallback(() => {
    if (multi.size < 2) {
      say("Birleştirmek için listede Ctrl/⌘ ile tıklayarak en az iki kayıt seçin.");
      return;
    }
    setDialog("merge");
  }, [multi, say]);

  return { trim, split, merge, openMerge };
}
