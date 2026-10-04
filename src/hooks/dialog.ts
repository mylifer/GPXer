/** Açık pencere (aynı anda en fazla biri). */
export type Dialog = "settings" | "summary" | "merge" | "tag" | "help" | "goto" | "duplicates" | "day" | "video" | null;

export type SetDialog = (d: Dialog) => void;
