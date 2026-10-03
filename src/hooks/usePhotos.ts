import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readPhotos, type FileSummary, type PhotoInfo } from "../api";
import type { Prefs } from "../prefs";
import type { FileEntry } from "../types";
import { fmtNumber } from "../format";
import { placePhotos } from "../photos";
import { parentDir } from "../lib/paths";

/** Aynı klasörden bundan çok fotoğraf bırakılırsa ayarlara klasör yazılır. */
const PHOTO_FOLDER_MIN = 50;
/** Ayarlarda saklanan en fazla fotoğraf yolu. */
const PHOTO_STORE_MAX = 200;
const PHOTO_EXTS = ["jpg", "jpeg", "JPG", "JPEG", "heic", "HEIC", "heif", "png", "PNG", "tif", "tiff", "dng", "DNG", "webp"];

/** Haritadaki fotoğraflar: eklenenler, yerleri, ekleme ve temizleme. */
export function usePhotos({
  prefs,
  prefsRef,
  up,
  say,
  fail,
  summaries,
  filesRef,
}: {
  prefs: Prefs;
  prefsRef: RefObject<Prefs>;
  up(patch: Partial<Prefs>): void;
  say(msg: string): void;
  fail(message: string): void;
  summaries: FileSummary[];
  filesRef: RefObject<FileEntry[]>;
}) {
  const [photoInfo, setPhotoInfo] = useState<PhotoInfo[]>([]);

  /** Fotoğrafların haritadaki yerleri (GPS ya da çekim zamanına göre iz). */
  const placedPhotos = useMemo(
    () => placePhotos(photoInfo, summaries, prefs.photoOffsetH),
    [photoInfo, summaries, prefs.photoOffsetH],
  );
  const mapPhotos = prefs.photosLayer && placedPhotos.placed.length ? placedPhotos.placed : null;

  const addPhotoPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      const prev = prefsRef.current.photos;
      const known = new Set(prev);
      const fresh = paths.filter((p) => !known.has(p));
      // Çok sayıda dosya ayarlara tek tek yazılmasın: hepsi aynı klasördense
      // klasör saklanır (read_photos klasörleri okur); değilse sınırlanır.
      const dirs = new Set(fresh.map(parentDir));
      const dir = fresh.length > PHOTO_FOLDER_MIN && dirs.size === 1 ? [...dirs][0] : null;
      let capNote = "";
      if (dir) {
        const inside = (p: string) => p === dir || parentDir(p) === dir;
        up({ photos: [...prev.filter((p) => !inside(p)), dir], photosLayer: true });
      } else {
        const all = [...prev, ...fresh];
        if (all.length > PHOTO_STORE_MAX) {
          up({ photos: all.slice(0, PHOTO_STORE_MAX), photosLayer: true });
          capNote = ` En fazla ${fmtNumber(PHOTO_STORE_MAX)} fotoğraf hatırlanır: ${fmtNumber(all.length - PHOTO_STORE_MAX)} tanesi bir sonraki açılışta gösterilmeyecek (klasör olarak eklemek daha iyi olur).`;
        } else up({ photos: all, photosLayer: true });
      }
      try {
        const list = (await readPhotos(paths)) ?? [];
        setPhotoInfo((prev) => {
          const byPath = new Map(prev.map((x) => [x.path, x]));
          for (const x of list) byPath.set(x.path, x);
          return [...byPath.values()];
        });
        const placed = placePhotos(list, filesRef.current.map((f) => f.summary), prefsRef.current.photoOffsetH);
        say(
          (list.length
            ? `${fmtNumber(list.length)} fotoğraf eklendi; ${fmtNumber(placed.placed.length)} tanesi haritada${
                placed.unplaced ? ` (${fmtNumber(placed.unplaced)} tanesinin konumu ya da o saatte kaydı yok)` : ""
              }.`
            : "Fotoğraf bulunamadı.") + capNote,
        );
      } catch (e) {
        fail(`Fotoğraflar okunamadı: ${e}`);
      }
    },
    [up, say, fail],
  );
  const pickPhotos = useCallback(
    async (folder: boolean) => {
      const res = folder
        ? await open({ directory: true, multiple: true })
        : await open({ multiple: true, filters: [{ name: "Fotoğraflar", extensions: PHOTO_EXTS }] });
      if (res) addPhotoPaths(Array.isArray(res) ? res : [res]);
    },
    [addPhotoPaths],
  );
  const clearPhotos = useCallback(() => {
    up({ photos: [] });
    setPhotoInfo([]);
  }, [up]);
  const addPhotosRef = useRef(addPhotoPaths);
  addPhotosRef.current = addPhotoPaths;

  return { photoInfo, setPhotoInfo, placedPhotos, mapPhotos, pickPhotos, clearPhotos, addPhotosRef };
}
