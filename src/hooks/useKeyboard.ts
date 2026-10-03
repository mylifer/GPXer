import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { Detail } from "../api";
import type { Route } from "../routes";
import type { FileEntry } from "../types";
import type { Dialog, SetDialog } from "./dialog";

/** Klavye: Esc, ↑/↓, Boşluk, ?, G. */
export function useKeyboard({
  rows,
  selected,
  range,
  multi,
  detail,
  dialog,
  routeModal,
  areaMode,
  compare,
  pick,
  anchor,
  filesRef,
  setAreaMode,
  setCompare,
  setRange,
  setMulti,
  setDialog,
  setPlaying,
}: {
  rows: FileEntry[];
  selected: string | null;
  range: [number, number] | null;
  multi: Set<string>;
  detail: Detail | null;
  dialog: Dialog;
  routeModal: Route | null;
  areaMode: boolean;
  compare: [string, string] | null;
  pick(path: string | null): void;
  anchor: RefObject<string | null>;
  filesRef: RefObject<FileEntry[]>;
  setAreaMode: Dispatch<SetStateAction<boolean>>;
  setCompare: Dispatch<SetStateAction<[string, string] | null>>;
  setRange: Dispatch<SetStateAction<[number, number] | null>>;
  setMulti: Dispatch<SetStateAction<Set<string>>>;
  setDialog: SetDialog;
  setPlaying: Dispatch<SetStateAction<boolean>>;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog || routeModal) return;
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el.isContentEditable) return;
      if (e.key === "Escape") {
        if (areaMode) setAreaMode(false);
        else if (compare) setCompare(null);
        else if (range) setRange(null);
        else if (multi.size) setMulti(new Set());
        else pick(null);
      }
      if (e.key === "?") {
        e.preventDefault();
        setDialog("help");
      }
      if ((e.key === "g" || e.key === "G") && filesRef.current.length) {
        e.preventDefault();
        setDialog("goto");
      }
      if (e.key === " " && detail && tag !== "BUTTON") {
        e.preventDefault();
        setPlaying((v) => !v);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = rows.findIndex((f) => f.summary.path === selected);
        const next = e.key === "ArrowDown" ? idx + 1 : idx < 0 ? rows.length - 1 : idx - 1;
        const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
        // Seçilen satırı görünür kılmak kenar çubuğunun işi (liste sanal; satır henüz çizilmemiş olabilir).
        if (target) {
          pick(target.summary.path);
          anchor.current = target.summary.path;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected, range, multi, detail, dialog, routeModal, areaMode, compare, pick]);
}
