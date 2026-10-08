import { useCallback, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { backupLibrary, getPlaces, NEED_PASSWORD, pickSavePath, restoreLibrary, type LoadResult, type NamedPlace } from "../api";
import type { PasswordAsk } from "../components/PasswordModal";
import { fmtBytes, fmtNumber } from "../format";
import type { FileEntry } from "../types";
import type { SetDialog } from "./dialog";

/** Kütüphane yedeği (isteğe bağlı parolayla) ve yedekten geri yükleme. */
export function useBackup({
  addResults,
  refreshMeta,
  setPlacesState,
  setDialog,
  say,
  fail,
}: {
  addResults(results: LoadResult[]): FileEntry[];
  refreshMeta(): Promise<void>;
  setPlacesState(p: NamedPlace[]): void;
  setDialog: SetDialog;
  say(msg: string): void;
  fail(message: string): void;
}) {
  const [pwAsk, setPwAsk] = useState<PasswordAsk | null>(null);
  const askPassword = useCallback((a: Omit<PasswordAsk, "resolve">) => new Promise<string | null>((resolve) => setPwAsk({ ...a, resolve })), []);
  const backup = useCallback(async () => {
    try {
      const pw = await askPassword({
        title: "Yedek parolası",
        message:
          "İsterseniz yedeği parolayla şifreleyin (AES-256): parolasız açılamaz. Parolayı unutursanız yedek kurtarılamaz. Şifresiz yedek için boş bırakın.",
        create: true,
      });
      if (pw == null) return;
      const day = new Date().toISOString().slice(0, 10);
      const dest = await pickSavePath(`GPXer-yedek-${day}.zip`, [{ name: "GPXer yedeği", extensions: ["zip"] }]);
      if (!dest) return;
      const path = /\.zip$/i.test(dest) ? dest : `${dest}.zip`;
      // Uzantı eklenen yol onaylı değilse seçilen yol denenir; hata olursa ilk hata gösterilir.
      const r = await backupLibrary(path, pw || null).catch((e) =>
        path === dest ? Promise.reject(e) : backupLibrary(dest, pw || null).catch(() => Promise.reject(e)),
      );
      say(`${fmtNumber(r.records)} kayıt ${pw ? "parolayla şifrelenerek " : ""}yedeklendi (${fmtBytes(r.bytes)}).`);
    } catch (e) {
      fail(String(e));
    }
  }, [say, fail, askPassword]);
  const restore = useCallback(async () => {
    try {
      const src = await open({ multiple: false, filters: [{ name: "GPXer yedeği", extensions: ["zip"] }] });
      if (typeof src !== "string") return;
      setDialog(null);
      say("Yedek geri yükleniyor…");
      // Şifreli yedekte parola sorulur; yanlışsa yeniden.
      let r: Awaited<ReturnType<typeof restoreLibrary>> | null = null;
      let pw: string | null = null;
      let error: string | undefined;
      for (;;) {
        try {
          r = await restoreLibrary(src, pw);
          break;
        } catch (e) {
          const msg = String(e);
          if (msg !== NEED_PASSWORD && msg !== "Parola yanlış") throw e;
          if (msg === "Parola yanlış") error = "Parola yanlış; yeniden deneyin.";
          pw = await askPassword({ title: "Yedek parolası", message: "Bu yedek parolayla şifrelenmiş.", create: false, error });
          if (pw == null) return;
        }
      }
      const added = addResults(r.results);
      const dup = r.results.filter((x) => x.status === "duplicate").length;
      await refreshMeta();
      getPlaces()
        .then((p) => Array.isArray(p) && setPlacesState(p))
        .catch(() => {});
      say(
        `Yedekten ${fmtNumber(added.length)} kayıt eklendi` +
          (dup ? `, ${fmtNumber(dup)} kayıt zaten kütüphanedeydi` : "") +
          (r.metaMerged ? `; ${fmtNumber(r.metaMerged)} kaydın etiket ve notları aktarıldı` : "") +
          (r.placesAdded ? `; ${fmtNumber(r.placesAdded)} yer eklendi` : "") +
          ".",
      );
    } catch (e) {
      fail(String(e));
    }
  }, [say, fail, addResults, refreshMeta, setPlacesState]);
  return { pwAsk, setPwAsk, backup, restore };
}
