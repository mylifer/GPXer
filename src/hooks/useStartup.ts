import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  getMeta,
  getPlaces,
  getSettings,
  libraryFiles,
  readPhotos,
  takePendingPaths,
  type FileMeta,
  type NamedPlace,
  type PhotoInfo,
  type Settings,
} from "../api";
import type { Prefs } from "../prefs";
import type { FileEntry } from "../types";
import { isImagePath } from "../photos";
import type { OpenOptions } from "./useFileLoader";

/**
 * Başlangıç ve dış olaylar: sürükle-bırak, işletim sisteminden ve izlenen
 * klasörlerden gelen yollar; açılışta kütüphane, ayarlar, yerler, fotoğraflar.
 */
export function useStartup({
  openPaths,
  fail,
  addPhotosRef,
  setSettingsState,
  setMetaState,
  setPlacesState,
  setPhotoInfo,
  setSelected,
  prefsRef,
  filesRef,
  initialLoad,
}: {
  openPaths(paths: string[], opts?: OpenOptions): Promise<void>;
  fail(message: string): void;
  addPhotosRef: RefObject<(paths: string[]) => Promise<void>>;
  setSettingsState: Dispatch<SetStateAction<Settings | null>>;
  setMetaState: Dispatch<SetStateAction<Record<string, FileMeta>>>;
  setPlacesState: Dispatch<SetStateAction<NamedPlace[]>>;
  setPhotoInfo: Dispatch<SetStateAction<PhotoInfo[]>>;
  setSelected: Dispatch<SetStateAction<string | null>>;
  prefsRef: RefObject<Prefs>;
  filesRef: RefObject<FileEntry[]>;
  initialLoad: RefObject<boolean>;
}) {
  const [dragging, setDragging] = useState(false);
  /** Açılışta kayıtlı bir harita konumu var mıydı (harita kendi ilk konumunu da kaydeder). */
  const hadView = useRef(prefsRef.current.mapView != null);

  useEffect(() => {
    const unlisten: Promise<() => void>[] = [];
    const drainPending = () =>
      takePendingPaths()
        .then((p) => openPaths(p, { explicit: true }))
        .catch((e) => fail(String(e)));

    unlisten.push(
      getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === "enter" || t === "over") setDragging(true);
        else if (t === "leave") setDragging(false);
        else if (t === "drop") {
          setDragging(false);
          // Fotoğraflar haritaya, iz dosyaları ve klasörler kütüphaneye.
          const photos = e.payload.paths.filter(isImagePath);
          const rest = e.payload.paths.filter((p) => !isImagePath(p));
          if (photos.length) addPhotosRef.current(photos);
          if (rest.length) openPaths(rest, { explicit: true });
        }
      }),
    );
    unlisten.push(listen("pending-paths", drainPending));
    unlisten.push(listen<string[]>("watched-paths", (e) => openPaths(e.payload, { quiet: true, noFit: true, noSelect: true })));
    return () => unlisten.forEach((p) => p.then((fn) => fn()));
  }, [openPaths, fail]);

  // Açılış: kütüphane, izlenen klasörlerdeki yeni dosyalar, işletim sisteminden gelenler.
  useEffect(() => {
    let done = false;
    (async () => {
      const s = await getSettings().catch(() => null);
      if (done) return;
      if (s) setSettingsState(s);
      getMeta()
        .then(setMetaState)
        .catch(() => {});
      getPlaces()
        .then((p) => Array.isArray(p) && setPlacesState(p))
        .catch(() => {});
      try {
        await openPaths(await libraryFiles(), { quiet: true, noFit: hadView.current, noSelect: true });
        if (s?.watchedFolders.length) await openPaths(s.watchedFolders, { quiet: true, noFit: true, noSelect: true });
      } catch (e) {
        fail(`Kütüphane yüklenemedi: ${e}`);
      } finally {
        initialLoad.current = false;
        // Kayıtlı seçim artık yoksa bırak.
        setSelected((sel) => (sel && filesRef.current.some((f) => f.summary.path === sel) ? sel : null));
      }
      // Kayıtlı fotoğraflar kütüphaneden sonra, arka planda okunur.
      const photoPaths = prefsRef.current.photos;
      if (photoPaths.length) {
        readPhotos(photoPaths)
          .then((list) => Array.isArray(list) && setPhotoInfo(list))
          .catch((e) => fail(`Fotoğraflar okunamadı: ${e}`));
      }
      try {
        await openPaths(await takePendingPaths(), { explicit: true });
      } catch (e) {
        fail(String(e));
      }
    })();
    return () => {
      done = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return { dragging };
}
