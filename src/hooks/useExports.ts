import { useCallback, type RefObject } from "react";
import { t } from "../i18n";
import { ask } from "@tauri-apps/plugin-dialog";
import { exportAs, exportMany, pickSavePath, writeBase64File, writeTextFile, type FileMeta } from "../api";
import type { MapHandle } from "../components/MapView";
import type { FileEntry } from "../types";
import { fmtNumber } from "../format";
import { csvFor } from "../csv";
import { formatOf } from "../lib/paths";

/** Bu sayıdan çok kayıt tek dosyaya aktarılacaksa onay sorulur. */
const EXPORT_CONFIRM = 500;

const SAVE_FILTERS = [
  { name: "GPX", extensions: ["gpx"] },
  { name: "KML (Google Earth)", extensions: ["kml"] },
  { name: "TCX (Garmin)", extensions: ["tcx"] },
  { name: "FIT (Garmin, Strava)", extensions: ["fit"] },
];

/** Dışa aktarma: CSV özeti, harita görüntüsü, tek kayıt ve birden çok kayıt. */
/** Çoklu seçimdeki kayıtlar: görünenler liste sırasıyla, ardından süzgeçle
 * gizlenmiş seçili kayıtlar (yalnızca görünenler alınıyordu). */
function selectedEntries(multi: Set<string>, shown: FileEntry[], all: FileEntry[]): FileEntry[] {
  const seen = new Set<string>();
  const out: FileEntry[] = [];
  for (const f of [...shown, ...all]) {
    if (multi.has(f.summary.path) && !seen.has(f.summary.path)) {
      seen.add(f.summary.path);
      out.push(f);
    }
  }
  return out;
}

export function useExports({
  multi,
  shown,
  meta,
  selected,
  filesRef,
  mapRef,
  say,
  fail,
}: {
  multi: Set<string>;
  shown: FileEntry[];
  meta: Record<string, FileMeta>;
  selected: string | null;
  filesRef: RefObject<FileEntry[]>;
  mapRef: RefObject<MapHandle | null>;
  say(msg: string): void;
  fail(message: string): void;
}) {
  const exportCsv = useCallback(async () => {
    const list = multi.size > 1 ? selectedEntries(multi, shown, filesRef.current) : shown;
    if (list.length === 0) return;
    try {
      const path = await pickSavePath("gpxer-ozet.csv", [{ name: "CSV", extensions: ["csv"] }]);
      if (!path) return;
      await writeTextFile(path, csvFor(list, meta));
      say(`${fmtNumber(list.length)} kaydın özeti kaydedildi.`);
    } catch (e) {
      fail(String(e));
    }
  }, [multi, shown, say, fail, meta, filesRef]);

  const exportPng = useCallback(async () => {
    try {
      const data = await mapRef.current!.exportPng();
      const path = await pickSavePath("gpxer-harita.png", [{ name: "PNG", extensions: ["png"] }]);
      if (!path) return;
      await writeBase64File(path, data);
      say("Harita görüntüsü kaydedildi.");
    } catch (e) {
      fail(`Harita görüntüsü alınamadı: ${e}`);
    }
  }, [say, fail]);

  const exportSelectedGpx = useCallback(async () => {
    const f = filesRef.current.find((x) => x.summary.path === selected);
    if (!f) return;
    try {
      // Varsayılan biçim GPX; biçim seçilen yolun uzantısından belirlenir.
      const stem = f.summary.fileName.replace(/\.[^.]+$/, "") || f.summary.fileName;
      const path = await pickSavePath(`${stem}.gpx`, SAVE_FILTERS);
      if (!path) return;
      const { format, hasExt } = formatOf(path);
      if (hasExt) {
        await exportAs(f.summary.path, path, format);
      } else {
        // Uzantısız ad: ".gpx" eklenir. Arka uç yalnızca pencerede seçilen yolu
        // kabul ediyorsa seçilen ad olduğu gibi kullanılır.
        try {
          await exportAs(f.summary.path, `${path}.gpx`, "gpx");
        } catch {
          await exportAs(f.summary.path, path, "gpx");
        }
      }
      say(`${format.toUpperCase()} dosyası kaydedildi.`);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, say, fail]);

  /** Birden çok kaydı tek dosyada dışa aktarır. */
  const exportPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      if (paths.length > EXPORT_CONFIRM) {
        const ok = await ask(
          t(`${fmtNumber(paths.length)} kayıt tek bir dosyada dışa aktarılsın mı? Dosya çok büyük olabilir ve biraz sürebilir.`),
          { title: t("Toplu dışa aktarma"), kind: "warning", okLabel: t("Dışa aktar"), cancelLabel: t("Vazgeç") },
        );
        if (!ok) return;
      }
      try {
        const path = await pickSavePath(`GPXer-${paths.length}-kayit.gpx`, SAVE_FILTERS);
        if (!path) return;
        const { format, hasExt } = formatOf(path);
        say(`${fmtNumber(paths.length)} kayıt dışa aktarılıyor…`);
        if (hasExt) await exportMany(paths, path, format);
        else {
          try {
            await exportMany(paths, `${path}.gpx`, "gpx");
          } catch {
            await exportMany(paths, path, "gpx");
          }
        }
        say(`${fmtNumber(paths.length)} kayıt tek ${format.toUpperCase()} dosyasına kaydedildi.`);
      } catch (e) {
        fail(String(e));
      }
    },
    [say, fail],
  );
  const exportFiltered = useCallback(() => exportPaths(shown.map((f) => f.summary.path)), [exportPaths, shown]);
  const exportMulti = useCallback(
    () => exportPaths(selectedEntries(multi, shown, filesRef.current).map((f) => f.summary.path)),
    [exportPaths, shown, multi, filesRef],
  );

  return { exportCsv, exportPng, exportSelectedGpx, exportFiltered, exportMulti };
}
