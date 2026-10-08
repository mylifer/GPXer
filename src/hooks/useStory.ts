import { useCallback, type RefObject } from "react";
import { loadDetail, photoThumb, pickSavePath, writeBase64File, writeTextFile, type Detail, type FileSummary, type NamedPlace } from "../api";
import type { MapHandle } from "../components/MapView";
import { nightsOf } from "../nights";
import { inZone, type Zone } from "../privacy";
import { storyHtml, type StoryPhoto } from "../story";
import type { FileEntry } from "../types";
import { combineDetails, combineRecords } from "../tripStory";
import { tripName } from "../trips";
import type { PlacedPhoto } from "../photos";

/** Seçili kaydın gezi hikâyesi (tek sayfalık HTML) ve görüntü kaydetme. */
export function useStory({
  selectedEntry,
  detail,
  placedPhotos,
  places,
  zones,
  mapRef,
  notes,
  say,
  fail,
}: {
  /** Günlük notları (gezi hikâyesinde gün gün). */
  notes: Record<string, string>;
  selectedEntry: FileEntry | null | undefined;
  detail: Detail | null;
  placedPhotos: { placed: PlacedPhoto[] };
  places: NamedPlace[];
  zones: Zone[];
  mapRef: RefObject<MapHandle | null>;
  say(msg: string): void;
  fail(message: string): void;
}) {
  /** Hikâyeyi üretip kaydeder: tek kayıt ya da birleştirilmiş gezi. */
  const write = useCallback(
    async (entries: FileEntry[], s: FileSummary, d: Detail | null) => {
      try {
        say("Gezi hikâyesi hazırlanıyor…");
        mapRef.current?.fitFiles(entries);
        await new Promise((r) => setTimeout(r, 1500));
        const mapPng = await mapRef.current?.exportPng().catch(() => null);
        const paths = new Set(entries.map((e) => e.summary.path));
        const own = placedPhotos.placed.filter((ph) => ph.record != null && paths.has(ph.record) && !inZone([ph.lon, ph.lat], zones)).slice(0, 40);
        const photos = (
          await Promise.all(
            own.map(async (ph) => {
              const src = await photoThumb(ph.path).catch(() => null);
              return src ? { name: ph.name, time: ph.at, src } : null;
            }),
          )
        ).filter((x): x is StoryPhoto => !!x);
        const html = storyHtml({ s, detail: d, mapPng: mapPng ?? null, nights: nightsOf(s, places), photos, notes });
        const stem = (s.name || s.fileName).replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");
        const path = await pickSavePath(`${stem}.html`, [{ name: "HTML", extensions: ["html"] }]);
        if (!path) return;
        await writeTextFile(path, html);
        say("Gezi hikâyesi kaydedildi; tarayıcıda açılabilir.");
      } catch (e) {
        fail(`Gezi hikâyesi oluşturulamadı: ${e}`);
      }
    },
    [mapRef, placedPhotos, places, zones, notes, say, fail],
  );
  const makeStory = useCallback(() => {
    if (selectedEntry) void write([selectedEntry], selectedEntry.summary, detail);
  }, [selectedEntry, detail, write]);
  /** Birden çok kaydın (bir gezinin) tek sayfalık hikâyesi. */
  const makeTripStory = useCallback(
    async (entries: FileEntry[]) => {
      if (entries.length < 2) {
        if (entries[0]) void write(entries, entries[0].summary, null);
        return;
      }
      const list = entries.map((e) => e.summary);
      const name = tripName(list);
      const details = await Promise.all(list.map((s) => loadDetail(s.path).catch(() => null)));
      const ok = details.every((d): d is Detail => d != null);
      const sorted = [...list].sort((a, b) => (a.stats.startTime ?? 0) - (b.stats.startTime ?? 0));
      const byPath = new Map(list.map((s, i) => [s.path, details[i]]));
      await write(entries, combineRecords(list, name), ok ? combineDetails(sorted.map((s) => byPath.get(s.path)!)) : null);
    },
    [write],
  );
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
  return { makeStory, makeTripStory, saveImage };
}
