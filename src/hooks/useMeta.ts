import { useCallback, useMemo, useState } from "react";
import type { SetDialog } from "./dialog";
import { setMeta as saveMeta, type FileMeta } from "../api";
import { fmtNumber } from "../format";
import type { FileEntry } from "../types";

export const EMPTY_META: FileMeta = { tags: [], note: "", activity: null };

/** Kayıtların tür/etiket/notları. */
export function useMeta({
  fail,
  say,
  patchFiles,
  multi,
  setDialog,
}: {
  fail(message: string, path?: string): void;
  say(msg: string): void;
  patchFiles(fn: (list: FileEntry[]) => FileEntry[]): void;
  multi: Set<string>;
  setDialog: SetDialog;
}) {
  const [meta, setMetaState] = useState<Record<string, FileMeta>>({});

  const allTags = useMemo(
    () => [...new Set(Object.values(meta).flatMap((m) => m.tags))].sort((a, b) => a.localeCompare(b, "tr-TR")),
    [meta],
  );

  /** Kaydın tür/etiket/notunu kaydeder; tür değişince özeti günceller. */
  const updateMeta = useCallback(
    async (path: string, m: FileMeta) => {
      setMetaState((prev) => ({ ...prev, [path]: m }));
      try {
        const res = await saveMeta(path, m);
        if (res?.status === "ok") {
          patchFiles((prev) => prev.map((f) => (f.summary.path === path ? { ...f, summary: res.file } : f)));
        } else if (res?.status === "error") fail(res.message, path);
      } catch (e) {
        fail(String(e), path);
      }
    },
    [fail, patchFiles],
  );

  const tagMany = useCallback(
    async (tag: string) => {
      setDialog(null);
      const paths = [...multi];
      for (const p of paths) {
        const m = meta[p] ?? EMPTY_META;
        if (!m.tags.includes(tag)) await updateMeta(p, { ...m, tags: [...m.tags, tag] });
      }
      say(`${fmtNumber(paths.length)} kayda “${tag}” etiketi eklendi.`);
    },
    [multi, meta, updateMeta, say],
  );

  return { meta, setMetaState, allTags, updateMeta, tagMany };
}
