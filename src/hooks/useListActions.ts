import { useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { RowModifiers } from "../components/Sidebar";
import type { FileEntry } from "../types";
import type { Filters, Prefs } from "../prefs";
import type { SetDialog } from "./dialog";

/**
 * Kenar çubuğu işleyicileri: satır tıklama (çoklu seçim), görünürlük, renk,
 * filtreler, gruplar. Kimlikleri sabittir (Sidebar memo ile sarılınca imleç/
 * oynatma gibi ilgisiz değişikliklerde yeniden çizilmesin).
 */
export function useListActions({
  rows,
  selected,
  pick,
  setMulti,
  patchFiles,
  up,
  prefsRef,
  filesRef,
  shownRef,
  setDialog,
}: {
  rows: FileEntry[];
  selected: string | null;
  pick(path: string | null): void;
  setMulti: Dispatch<SetStateAction<Set<string>>>;
  patchFiles(fn: (list: FileEntry[]) => FileEntry[]): void;
  up(patch: Partial<Prefs>): void;
  prefsRef: RefObject<Prefs>;
  filesRef: RefObject<FileEntry[]>;
  shownRef: RefObject<FileEntry[]>;
  setDialog: SetDialog;
}) {
  const anchor = useRef<string | null>(null);

  const onRowClick = useCallback(
    (path: string, mods: RowModifiers) => {
      if (mods.range && anchor.current) {
        const order = rows.map((f) => f.summary.path);
        const a = order.indexOf(anchor.current);
        const b = order.indexOf(path);
        if (a >= 0 && b >= 0) {
          setMulti(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)));
          return;
        }
      }
      if (mods.toggle) {
        setMulti((m) => {
          const next = new Set(m);
          if (next.size === 0 && selected) next.add(selected);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchor.current = path;
        return;
      }
      setMulti(new Set());
      anchor.current = path;
      pick(path);
    },
    [rows, selected, pick],
  );

  const setVisible = useCallback(
    (paths: string[], visible: boolean) => {
      const ids = new Set(paths);
      patchFiles((prev) => prev.map((f) => (ids.has(f.summary.path) ? { ...f, visible } : f)));
      const hidden = new Set(prefsRef.current.hidden);
      for (const p of paths) {
        if (visible) hidden.delete(p);
        else hidden.add(p);
      }
      up({ hidden: [...hidden] });
    },
    [up, patchFiles],
  );

  const toggle = useCallback(
    (path: string) => {
      const f = filesRef.current.find((x) => x.summary.path === path);
      if (f) setVisible([path], !f.visible);
    },
    [setVisible],
  );

  const setColor = useCallback(
    (path: string, color: string) => {
      patchFiles((prev) => prev.map((f) => (f.summary.path === path ? { ...f, color } : f)));
      up({ colors: { ...prefsRef.current.colors, [path]: color }, colorMode: "file" });
    },
    [up, patchFiles],
  );

  const setFilters = useCallback((filters: Filters) => up({ filters }), [up]);

  // Kenar çubuğu için sabit kimlikli işleyiciler (Sidebar memo ile sarılınca
  // imleç/oynatma gibi ilgisiz değişikliklerde yeniden çizilmesin).
  const onGroupBy = useCallback((groupBy: Prefs["groupBy"]) => up({ groupBy }), [up]);
  const onToggleGroup = useCallback(
    (key: string) => {
      const c = prefsRef.current.collapsed;
      up({ collapsed: c.includes(key) ? c.filter((k) => k !== key) : [...c, key] });
    },
    [up],
  );
  const onToggleAll = useCallback(
    (v: boolean) => setVisible(shownRef.current.map((f) => f.summary.path), v),
    [setVisible],
  );
  const openSettings = useCallback(() => setDialog("settings"), []);
  const openHelp = useCallback(() => setDialog("help"), []);
  const openGoTo = useCallback(() => setDialog("goto"), []);
  const dismissMultiHint = useCallback(() => up({ multiHintSeen: true }), [up]);
  const openSummary = useCallback(() => setDialog("summary"), []);
  const openTag = useCallback(() => setDialog("tag"), []);
  const clearMulti = useCallback(() => setMulti(new Set()), []);

  return {
    anchor,
    onRowClick,
    setVisible,
    toggle,
    setColor,
    setFilters,
    onGroupBy,
    onToggleGroup,
    onToggleAll,
    openSettings,
    openHelp,
    openGoTo,
    dismissMultiHint,
    openSummary,
    openTag,
    clearMulti,
  };
}
