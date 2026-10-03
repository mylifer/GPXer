import { useCallback, type Dispatch, type SetStateAction } from "react";
import { mergeFiles, splitFile, trimFile, type Detail, type LoadResult } from "../api";
import type { FileEntry } from "../types";
import type { SetDialog } from "./dialog";

/** İz düzenleme: kırpma, bölme, birleştirme (yeni kayıt oluşturur, orijinal kalır). */
export function useTrackEdits({
  selected,
  detail,
  range,
  shown,
  multi,
  setMulti,
  setDialog,
  addResults,
  pick,
  say,
  fail,
}: {
  selected: string | null;
  detail: Detail | null;
  range: [number, number] | null;
  shown: FileEntry[];
  multi: Set<string>;
  setMulti: Dispatch<SetStateAction<Set<string>>>;
  setDialog: SetDialog;
  addResults(results: LoadResult[]): FileEntry[];
  pick(path: string | null): void;
  say(msg: string): void;
  fail(message: string): void;
}) {
  const trim = useCallback(async () => {
    if (!selected || !detail || !range) return;
    try {
      const added = addResults([await trimFile(selected, detail.idx[range[0]], detail.idx[range[1]])]);
      if (added[0]) pick(added[0].summary.path);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, detail, range, addResults, fail, pick]);

  const split = useCallback(async () => {
    if (!selected || !detail || !range) return;
    try {
      const added = addResults(await splitFile(selected, detail.idx[range[0]]));
      if (added.length === 2) say("Kayıt ikiye bölündü; iki yeni kayıt eklendi (orijinal duruyor).");
      if (added[1]) pick(added[1].summary.path);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, detail, range, addResults, fail, say, pick]);

  const merge = useCallback(
    async (name: string) => {
      setDialog(null);
      const paths = shown.filter((f) => multi.has(f.summary.path)).map((f) => f.summary.path);
      try {
        const added = addResults([await mergeFiles(paths, name)]);
        if (added[0]) {
          setMulti(new Set());
          pick(added[0].summary.path);
          say(`${paths.length} kayıt birleştirildi (orijinaller duruyor).`);
        }
      } catch (e) {
        fail(String(e));
      }
    },
    [shown, multi, addResults, say, fail, pick],
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
