import { useCallback, type RefObject } from "react";
import { photoThumb, pickSavePath, writeBase64File, writeTextFile, type Detail, type NamedPlace } from "../api";
import type { MapHandle } from "../components/MapView";
import { nightsOf } from "../nights";
import { inZone, type Zone } from "../privacy";
import { storyHtml, type StoryPhoto } from "../story";
import type { FileEntry } from "../types";
import type { PlacedPhoto } from "../photos";

/** Seçili kaydın gezi hikâyesi (tek sayfalık HTML) ve görüntü kaydetme. */
export function useStory({
  selectedEntry,
  detail,
  placedPhotos,
  places,
  zones,
  mapRef,
  say,
  fail,
}: {
  selectedEntry: FileEntry | null | undefined;
  detail: Detail | null;
  placedPhotos: { placed: PlacedPhoto[] };
  places: NamedPlace[];
  zones: Zone[];
  mapRef: RefObject<MapHandle | null>;
  say(msg: string): void;
  fail(message: string): void;
}) {
  const makeStory = useCallback(async () => {
    const entry = selectedEntry;
    if (!entry) return;
    const s = entry.summary;
    try {
      say("Gezi hikâyesi hazırlanıyor…");
      mapRef.current?.fitFiles([entry]);
      await new Promise((r) => setTimeout(r, 1500));
      const mapPng = await mapRef.current?.exportPng().catch(() => null);
      const own = placedPhotos.placed.filter((ph) => ph.record === s.path && !inZone([ph.lon, ph.lat], zones)).slice(0, 40);
      const photos = (
        await Promise.all(
          own.map(async (ph) => {
            const src = await photoThumb(ph.path).catch(() => null);
            return src ? { name: ph.name, time: ph.at, src } : null;
          }),
        )
      ).filter((x): x is StoryPhoto => !!x);
      const html = storyHtml({ s, detail, mapPng: mapPng ?? null, nights: nightsOf(s, places), photos });
      const stem = (s.name || s.fileName).replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");
      const path = await pickSavePath(`${stem}.html`, [{ name: "HTML", extensions: ["html"] }]);
      if (!path) return;
      await writeTextFile(path, html);
      say("Gezi hikâyesi kaydedildi; tarayıcıda açılabilir.");
    } catch (e) {
      fail(`Gezi hikâyesi oluşturulamadı: ${e}`);
    }
  }, [selectedEntry, detail, placedPhotos, places, zones, say, fail]);
  const saveImage = useCallback(
    async (name: string, data: string) => {
      try {
        const path = await pickSavePath(name, [{ name: "PNG", extensions: ["png"] }]);
        if (!path) return;
        await writeBase64File(path, data);
        say("Görüntü kaydedildi.");
      } catch (e) {
        fail(`Görüntü kaydedilemedi: ${e}`);
      }
    },
    [say, fail],
  );
  return { makeStory, saveImage };
}
