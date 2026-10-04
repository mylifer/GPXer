/** Arayüz görünümü: "modern" (Mantine) ya da "classic" (ilk tasarım). Açılışta
 * bir kez okunur; değişince sayfa yenilenir (iki görünümün stilleri karışmaz). */
export type UiMode = "modern" | "classic";

const KEY = "gpxer.ui";

function read(): UiMode {
  try {
    return localStorage.getItem(KEY) === "classic" ? "classic" : "modern";
  } catch {
    return "modern";
  }
}

export const uiMode: UiMode = read();
export const isModern = uiMode === "modern";

export function saveUiMode(m: UiMode) {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // Saklanamazsa bu oturumda değişmez.
  }
}
