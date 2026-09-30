import type { FileSummary } from "./api";

export interface FileEntry {
  summary: FileSummary;
  color: string;
  visible: boolean;
}

/** Birbirinden kolay ayırt edilen, harita üzerinde okunaklı renkler. */
export const PALETTE = [
  "#e6194b",
  "#3c78d8",
  "#f58231",
  "#2e9e44",
  "#911eb4",
  "#00a3a3",
  "#d4379b",
  "#8c6d1f",
  "#1a237e",
  "#c0392b",
  "#6a9a00",
  "#ff6f00",
];
