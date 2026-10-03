import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { MapHandle } from "../components/MapView";
import type { GoToResult } from "../components/GoToDialog";
import type { FileEntry } from "../types";
import type { Prefs } from "../prefs";
import { fmtDuration, fmtTimestamp, tzOf } from "../format";
import { greatCircle, type Flight } from "../flights";
import { findAt as findAtIn, placeAtTime } from "../lib/goto";
import type { SetDialog } from "./dialog";

/** Haritada ve listede gezinme: yakınlaştırma, uçuşa/tarihe gitme, karşılaştırma. */
export function useNavigation({
  filesRef,
  onMapRef,
  prefsRef,
  mapRef,
  multi,
  pick,
  say,
  setDialog,
  setMulti,
  setCompare,
  setRange,
  setSeek,
}: {
  filesRef: RefObject<FileEntry[]>;
  onMapRef: RefObject<FileEntry[]>;
  prefsRef: RefObject<Prefs>;
  mapRef: RefObject<MapHandle | null>;
  multi: Set<string>;
  pick(path: string | null): void;
  say(msg: string): void;
  setDialog: SetDialog;
  setMulti: Dispatch<SetStateAction<Set<string>>>;
  setCompare: Dispatch<SetStateAction<[string, string] | null>>;
  setRange: Dispatch<SetStateAction<[number, number] | null>>;
  setSeek: Dispatch<SetStateAction<{ path: string; t: number } | null>>;
}) {
  /** Listede (filtreye uyan) ve haritada görünen kayıtlara yakınlaştırır. */
  const fitAll = useCallback(() => {
    mapRef.current?.fitFiles(onMapRef.current);
  }, []);

  const showFlight = useCallback(
    (f: Flight) => {
      setDialog(null);
      setMulti(new Set());
      setCompare(null);
      pick(f.path);
      mapRef.current?.fitPoints(greatCircle(f.from, f.to, 16));
    },
    [pick],
  );

  /** Duvar saatindeki (gg.aa.yyyy ss:dd) ana en yakın kayıt. */
  const findAt = useCallback(
    (wall: number): GoToResult => findAtIn(filesRef.current, wall, prefsRef.current.tzMode === "record"),
    [],
  );

  const goTo = useCallback(
    (r: GoToResult) => {
      if (r.kind === "none") return;
      const f = filesRef.current.find((x) => x.summary.path === r.path);
      if (!f) return;
      const s = f.summary;
      setDialog(null);
      setMulti(new Set());
      setCompare(null);
      setRange(null);
      pick(s.path);
      setSeek({ path: s.path, t: r.t });
      const { name: place, at } = placeAtTime(s, r.t);
      const name = s.name || s.fileName;
      const ago = (dt: number) => `${fmtDuration(Math.abs(dt))} ${dt < 0 ? "sonra" : "önce"}`;
      if (r.kind === "cover") {
        // Kaydın süresi içinde ama o saatte nokta yok (ör. aylarca süren kayıtta ara gün).
        if (at != null && Math.abs(at - r.t) > 30 * 60_000)
          say(`Bu anda ${name} kaydında veri yok (en yakın nokta: ${ago(r.t - at)} · ${fmtTimestamp(at, tzOf(s))}${place ? ` · ${place}` : ""})`);
        else say(`Bu anda: ${place ? `${place}, ` : ""}${name}`);
      } else say(`Kayıt yok (en yakın: ${name}, ${ago(r.dt)} · ${fmtTimestamp(r.t, tzOf(s))}${place ? ` · ${place}` : ""})`);
    },
    [pick, say],
  );

  const compareWith = useCallback(
    (a: string, b: string) => {
      const t = (p: string) => filesRef.current.find((f) => f.summary.path === p)?.summary.stats.startTime ?? 0;
      const pair: [string, string] = t(a) <= t(b) ? [a, b] : [b, a];
      setCompare(pair);
      pick(null);
      mapRef.current?.fitFiles(filesRef.current.filter((f) => pair.includes(f.summary.path)));
    },
    [pick],
  );

  const zoomTo = useCallback((path: string) => {
    const f = filesRef.current.find((x) => x.summary.path === path);
    if (f) mapRef.current?.fitFiles([f]);
  }, []);

  const selectAndZoom = useCallback(
    (path: string) => {
      pick(path);
      zoomTo(path);
    },
    [zoomTo, pick],
  );

  const startCompare = useCallback(() => {
    const pair = [...multi];
    if (pair.length !== 2) return;
    // Eski kayıt A, yeni kayıt B.
    const t = (p: string) => filesRef.current.find((f) => f.summary.path === p)?.summary.stats.startTime ?? 0;
    pair.sort((a, b) => t(a) - t(b));
    setCompare([pair[0], pair[1]]);
    pick(null);
    mapRef.current?.fitFiles(filesRef.current.filter((f) => pair.includes(f.summary.path)));
  }, [multi, pick]);

  return { fitAll, showFlight, findAt, goTo, compareWith, zoomTo, selectAndZoom, startCompare };
}
