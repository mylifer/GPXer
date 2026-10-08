import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  fixElevation,
  getMeta,
  pickSavePath,
  snapToRoads,
  undoRewrite,
  deletePoints,
  movePoint,
  type RewriteResult,
  type Bookmark,
  writeBase64File,
  prefetchTiles,
  addGpxRecord,
  timeZoneAt,
  type LoadResult,
  type RewriteKind,
} from "./api";
import type { MapHandle } from "./components/MapView";
import { Sidebar as ClassicSidebar } from "./components/Sidebar";
import { UpdateNotice } from "./components/UpdateNotice";
import { SettingsDialog } from "./components/SettingsDialog";
import { SummaryPanel } from "./components/SummaryPanel";
import { PromptModal } from "./components/Modal";
import { RouteModal } from "./components/RouteModal";
import { CompareView } from "./components/CompareView";
import { HelpDialog } from "./components/HelpDialog";
import { GoToDialog } from "./components/GoToDialog";
import { DuplicatesDialog } from "./components/DuplicatesDialog";
import { findDuplicates } from "./duplicates";
import { useRegions } from "./hooks/useRegions";
import { DayDialog } from "./components/DayDialog";
import { VideoDialog } from "./components/VideoDialog";
import { RouteSearchDialog } from "./components/RouteSearchDialog";
import { BookmarkEditor, BookmarkList } from "./components/BookmarkDialogs";
import { useBookmarks } from "./hooks/useBookmarks";
import { PlanPanel, type PlanState } from "./components/PlanPanel";
import { PasswordModal } from "./components/PasswordModal";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { paletteCommands } from "./paletteCommands";
import { explorerGeoJSON, explorerStats } from "./explorer";
import { privacyZones } from "./privacy";
import { blobToBase64 } from "./lib/blob";
import { dayBuckets } from "./days";
import { HoverDetailPanel, HoverMapView } from "./components/HoverViews";
import { MapToolbar as ClassicMapToolbar } from "./components/MapToolbar";
import { isModern } from "./ui/mode";
import { Rail } from "./ui/Rail";
import { ModernSidebar } from "./ui/ModernSidebar";
import { ModernMapToolbar } from "./ui/ModernMapToolbar";
import { MapSearch } from "./components/MapSearch";
import { StreetsDialog } from "./components/StreetsDialog";
import { MapLegends } from "./components/MapLegends";
import { OnThisDayCard } from "./components/OnThisDay";
import { Toasts } from "./components/Toasts";
import type { Route } from "./routes";
import { fmtDistance, fmtElevation, fmtNumber, isoOf, isoToTr, tzOf } from "./format";
import { photoTrips, tripGpx } from "./photos";
import { createIdxStore } from "./lib/idxStore";
import type { Dialog } from "./hooks/dialog";
import { useBaseLayer, usePrefs } from "./hooks/usePrefs";
import { useNotices } from "./hooks/useNotices";
import { useFileLoader } from "./hooks/useFileLoader";
import { usePlaces } from "./hooks/usePlaces";
import { EMPTY_META, useMeta } from "./hooks/useMeta";
import { useFilteredFiles } from "./hooks/useFilteredFiles";
import { usePhotos } from "./hooks/usePhotos";
import { useCompareDetails, useSelectedDetail } from "./hooks/useSelectedDetail";
import { useExports } from "./hooks/useExports";
import { useTrackEdits } from "./hooks/useTrackEdits";
import { useNavigation } from "./hooks/useNavigation";
import { useStartup } from "./hooks/useStartup";
import { useMenuHandlers } from "./hooks/useMenuHandlers";
import { useListActions } from "./hooks/useListActions";
import { useKeyboard } from "./hooks/useKeyboard";
import { useSync } from "./hooks/useSync";
import { useArchive } from "./hooks/useArchive";
import { useBackup } from "./hooks/useBackup";
import { usePlanRoute } from "./hooks/usePlanRoute";
import { useStory } from "./hooks/useStory";

/*
 * Uygulama: durum ve iş mantığı src/hooks altındaki kancalarda; burada
 * birleştirilip arayüze bağlanır. Kancaların çağrılma sırası efektlerin
 * çalışma sırasını belirler; sırayı değiştirirken dikkat.
 */
// Görünüme göre kenar çubuğu ve araç çubuğu (Klasik: ilk tasarım).
const Sidebar = isModern ? ModernSidebar : ClassicSidebar;
const MapToolbar = isModern ? ModernMapToolbar : ClassicMapToolbar;

/** Bir pencere (Modal) ya da komut paleti açık mı. */
const anyModalOpen = () => !!document.querySelector(".modal-backdrop, .palette");

export default function App() {
  const { prefs, prefsRef, persistedSel, up } = usePrefs();
  const [baseLayer, setBaseLayer] = useBaseLayer();
  const { errors, setErrors, duplicates, setDuplicates, empties, setEmpties, info, setInfo, say, fail } = useNotices();

  const [multi, setMulti] = useState<Set<string>>(new Set());
  /** İmleç (fare ya da oynatma); App'i her karede yeniden çizmemek için state değil. */
  const [cursor] = useState(createIdxStore);
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Rota planlama (kapalıyken null). */
  const [plan, setPlan] = useState<PlanState | null>(null);
  const openPlan = useCallback(() => {
    setEditMode(false);
    setPlan((s) => s ?? { points: [], profile: "car", route: null, busy: false, error: null });
  }, []);
  /** Düzenlenen (ya da yeni) yer imi. */
  const [editMark, setEditMark] = useState<{ mark: Bookmark; isNew: boolean } | null>(null);
  /** Güzergâh aramasının A ve B noktaları (haritada sağ tık menüsünden). */
  const [routePins, setRoutePins] = useState<{ a: [number, number] | null; b: [number, number] | null }>({ a: null, b: null });
  // Yerinde düzeltilen kayıtlar (geri almak için önceki halin yolu) ve süren işlem.
  const [detailRev, setDetailRev] = useState(0);
  /** Yerinde düzeltilen kayıtların önceki halleri (geri alma yığını, son en sonda). */
  const [rewritten, setRewritten] = useState<Record<string, string[]>>({});
  /** Haritada nokta düzenleme kipi ve seçili nokta (ayrıntı örnek sırası). */
  const [editMode, setEditMode] = useState(false);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [rewriting, setRewriting] = useState<{ path: string; kind: RewriteKind } | null>(null);
  const [areaMode, setAreaMode] = useState(false);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const [routeModal, setRouteModal] = useState<Route | null>(null);
  const mapRef = useRef<MapHandle>(null);
  const routeInfoRef = useRef<{ routes: Route[]; byPath: Map<string, Route> } | null>(null);

  // ---------- Kütüphane ve yükleme ----------

  const {
    files,
    filesRef,
    selected,
    setSelected,
    pick,
    patchFiles,
    loading,
    reloading,
    initialLoad,
    restoreSel,
    settings,
    settingsRef,
    setSettingsState,
    applySettings,
    watchOffer,
    setWatchOffer,
    undo,
    doUndo,
    openPaths,
    addResults,
    pickFiles,
    pickFolder,
    removePaths,
    forgetPaths,
    closeAll,
  } = useFileLoader({ prefsRef, persistedSel, up, say, fail, setErrors, setDuplicates, setEmpties, mapRef, setCompare, setMulti, routeInfoRef });
  const { places, setPlacesState, namePrompt, setNamePrompt, updatePlaces, onNamePlace, namePlace } = usePlaces(say, fail);
  const { meta, setMetaState, allTags, updateMeta, tagMany } = useMeta({ fail, say, patchFiles, multi, setDialog });

  // ---------- Türetilen veriler ----------

  const dark = baseLayer === "dark" || baseLayer === "satellite";
  const {
    colored,
    summaries,
    routeInfo,
    overlapInfo,
    shown,
    shownRef,
    groups,
    collapsed,
    rows,
    years,
    onMap,
    onMapRef,
    dateWindow,
    mapFlights,
    selectedEntry,
    dateLegend,
    routeLabel,
    coloredByPath,
    summaryOf,
    libraryFlights,
    selOverlaps,
  } = useFilteredFiles({ files, prefs, meta, places, dark, selected, routeInfoRef });
  const bookmarks = useBookmarks(fail);
  /** Gizlilik bölgeleri (“gizli” işaretli adlandırılmış yerler). */
  const zones = useMemo(() => privacyZones(places), [places]);
  /** Keşif kareleri (katman açıkken, gösterilen kayıtlardan). */
  const explorer = useMemo(() => {
    if (!prefs.explorerLayer) return null;
    const st = explorerStats(shown.map((f) => f.summary));
    return { st, geo: explorerGeoJSON(st) };
  }, [prefs.explorerLayer, shown]);
  const regions = useRegions(shown, prefs.filters.from, prefs.filters.to, prefs.regionsLayer);
  // Gün akışı: kaydı olan günler ve açılış günü (seçili kaydın ilk günü, yoksa son gün).
  const daysWithData = useMemo(
    () => (dialog === "day" ? [...new Set(shown.flatMap((f) => dayBuckets(f.summary).map((d) => d.day)))].sort() : []),
    [dialog, shown],
  );
  const initialDay = useMemo(() => {
    const sel = selectedEntry?.summary;
    const first = sel ? dayBuckets(sel)[0]?.day : undefined;
    return first ?? daysWithData[daysWithData.length - 1] ?? isoOf(new Date());
  }, [selectedEntry, daysWithData]);
  /** Aynı yolculuğun kopyaları (tüm kütüphanede). */
  const duplicateGroups = useMemo(() => findDuplicates(files.map((f) => f.summary)), [files]);
  const fileMap = useMemo(() => new Map(files.map((f) => [f.summary.path, f])), [files]);
  const { photoInfo, setPhotoInfo, placedPhotos, mapPhotos, pickPhotos, clearPhotos, addPhotosRef } = usePhotos({
    prefs,
    prefsRef,
    up,
    say,
    fail,
    summaries,
    filesRef,
  });

  // Dosya listesi değişince artık var olmayan kayıtlara bağlı durumu temizle
  // (açılış ve yeniden yükleme sürerken liste henüz eksik olabilir; beklenir).
  useEffect(() => {
    if (initialLoad.current || restoreSel.current !== undefined || loading) return;
    const has = (p: string) => files.some((f) => f.summary.path === p);
    if (selected && !has(selected)) setSelected(null);
    if (compare && !compare.every(has)) setCompare(null);
    // Güzergâh filtresi hiçbir güzergâha uymuyorsa sessizce boş liste göstermek yerine kaldır.
    const fr = prefs.filters.route;
    if (fr && !routeInfo.byPath.has(fr)) up({ filters: { ...prefsRef.current.filters, route: null } });
  }, [files, selected, compare, routeInfo, prefs.filters.route, loading, up]);

  // ---------- Seçili kayıt ----------

  // Tarih filtresi tek güne ayarlıysa (ör. takvimde güne tıklama) çok günlü
  // kaydın o günü kendiliğinden seçilir.
  const oneDay = prefs.filters.from && prefs.filters.from === prefs.filters.to ? prefs.filters.from : "";
  const { detail, detailError, range, setRange, rangeSt, playing, setPlaying, setSeek, onHoverIdx, zoomRange, pickDay } =
    useSelectedDetail({ selected, cursor, mapRef, prefsRef, oneDay, selSummary: selectedEntry?.summary ?? null, rev: detailRev });
  const { compareDetails, cursors, setCursors } = useCompareDetails(compare, fail);

  // ---------- Dışa aktarma, düzenleme, gezinme ----------

  const { exportCsv, exportPng, exportSelectedGpx, exportFiltered, exportMulti } = useExports({
    multi,
    shown,
    meta,
    selected,
    filesRef,
    mapRef,
    say,
    fail,
  });
  const refreshMeta = useCallback(
    () =>
      getMeta()
        .then(setMetaState)
        .catch(() => {}),
    [setMetaState],
  );
  // ---------- Yerinde düzeltme (arazi yüksekliği, yola oturtma) ----------
  const replaceSummary = useCallback(
    (r: LoadResult) => {
      if (r.status === "ok") patchFiles((prev) => prev.map((f) => (f.summary.path === r.file.path ? { ...f, summary: r.file } : f)));
      else if (r.status === "error") fail(r.message, r.path);
    },
    [patchFiles, fail],
  );
  // Kayıt yerinde değişince eski ayrıntı yeni ayrıntı gelene dek düzenlemede
  // kullanılmaz: eski dizinler yeni dosyada başka noktaları gösterir.
  const staleDetail = useRef(false);
  const editBusy = useRef(false);
  useEffect(() => {
    staleDetail.current = false;
  }, [detail]);
  const applyRewrite = useCallback(
    (path: string, r: RewriteResult) => {
      staleDetail.current = true;
      setRange(null);
      replaceSummary(r.result);
      setRewritten((m) => ({ ...m, [path]: [...(m[path] ?? []), r.previous] }));
      setDetailRev((x) => x + 1);
    },
    [replaceSummary, setRange],
  );
  /** Nokta düzenleme (silme, taşıma): yerinde, geri alınabilir. */
  const editPoints = useCallback(
    async (path: string, run: () => Promise<RewriteResult>, msg: string) => {
      // Çift tıklama, basılı tutulan Delete: önceki işlem ve yeni ayrıntı beklenir.
      if (editBusy.current || staleDetail.current) return;
      editBusy.current = true;
      try {
        applyRewrite(path, await run());
        setEditIdx(null);
        say(`${msg} “Düzeltmeyi geri al” ile geri alınabilir.`);
      } catch (e) {
        fail(String(e));
      } finally {
        editBusy.current = false;
      }
    },
    [applyRewrite, say, fail],
  );
  const rewrite = useCallback(
    async (path: string, kind: RewriteKind) => {
      setRewriting({ path, kind });
      try {
        const r = await (kind === "elevation" ? fixElevation(path) : snapToRoads(path));
        applyRewrite(path, r);
        const after = r.result.status === "ok" ? r.result.file.stats : null;
        say(
          kind === "elevation"
            ? `Yükseklikler arazi verisiyle düzeltildi: toplam tırmanış ${fmtElevation(r.before?.elevationGainM)} → ${fmtElevation(after?.elevationGainM)}.`
            : `Kayıt yollara oturtuldu: ${fmtNumber(r.before?.pointCount ?? 0)} → ${fmtNumber(after?.pointCount ?? 0)} nokta, mesafe ${fmtDistance(r.before?.distanceM)} → ${fmtDistance(after?.distanceM)}.`,
        );
      } catch (e) {
        fail(String(e));
      } finally {
        setRewriting(null);
      }
    },
    [applyRewrite, say, fail],
  );
  const undoRewriteOf = useCallback(
    async (path: string) => {
      const stack = rewritten[path];
      const prev = stack?.[stack.length - 1];
      if (!prev) return;
      try {
        staleDetail.current = true;
        setRange(null);
        replaceSummary(await undoRewrite(path, prev));
        setRewritten((m) => {
          const n = { ...m };
          const rest = (n[path] ?? []).slice(0, -1);
          if (rest.length) n[path] = rest;
          else delete n[path];
          return n;
        });
        setDetailRev((x) => x + 1);
        say("Kaydın düzeltmeden önceki haline dönüldü.");
      } catch (e) {
        fail(String(e));
      }
    },
    [rewritten, replaceSummary, setRange, say, fail],
  );
  // Nokta düzenlemede Delete seçili noktayı siler; kayıt değişince seçim kalkar.
  useEffect(() => {
    setEditIdx(null);
    setEditMode(false);
  }, [selected]);
  useEffect(() => {
    if (!editMode || editIdx == null || !detail || !selected) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || anyModalOpen()) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        if (e.repeat) return;
        const i = detail.idx[editIdx];
        if (i == null) return;
        editPoints(selected, () => deletePoints(selected, i, i), "Nokta silindi.");
      } else if (e.key === "Escape") {
        // Yalnızca nokta seçimi kalkar; genel Esc (kaydı kapatma) çalışmaz.
        e.preventDefault();
        setEditIdx(null);
      }
    };
    // Yakalama evresinde: genel kısayollardan önce çalışır.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [editMode, editIdx, detail, selected, editPoints]);
  // Arama tanılamasından: sokakları aramaya ekleme penceresi.
  useEffect(() => {
    const open = () => setDialog("streets");
    window.addEventListener("gpxer:open-streets", open);
    return () => window.removeEventListener("gpxer:open-streets", open);
  }, []);
  // ---------- Çevrimdışı harita: görünen alanı indir ----------
  const downloadArea = useCallback(async () => {
    const r = mapRef.current?.offlineTileUrls(3);
    if (!r) return;
    const note = r.skipped.length ? ` (${r.skipped.join(", ")} toplu indirmeye izin vermediği için atlandı; “Sokak” yerine başka altlık seçin)` : "";
    if (!r.urls.length) {
      say(`İndirilecek karo yok${note}.`);
      return;
    }
    say(`${fmtNumber(r.urls.length)} harita karosu indiriliyor…${r.capped ? " (en çok 4.000; daha küçük bir alana yakınlaşın)" : ""}`);
    let ok = 0;
    try {
      for (let i = 0; i < r.urls.length; i += 400) ok += await prefetchTiles(r.urls.slice(i, i + 400));
      say(`Bu alan çevrimdışı kullanıma hazır: ${fmtNumber(ok)} / ${fmtNumber(r.urls.length)} karo${note}.`);
    } catch (e) {
      fail(`Karolar indirilemedi: ${e}`);
    }
  }, [say, fail]);
  // ---------- Fotoğraflardan iz ----------
  const makePhotoTracks = useCallback(async () => {
    try {
      // Dilimsiz EXIF saatleri için konumların saat dilimi (yaklaşık 50 km'lik hücrelerde bir kez).
      const zones = new Map<string, string | null>();
      const cell = (lat: number, lon: number) => `${Math.round(lat * 2)}:${Math.round(lon * 2)}`;
      for (const p of photoInfo) {
        if (!p.timeIsLocal || p.lat == null || p.lon == null) continue;
        const k = cell(p.lat, p.lon);
        if (!zones.has(k)) zones.set(k, await timeZoneAt(p.lon, p.lat).catch(() => null));
      }
      const trips = photoTrips(photoInfo, (lat, lon) => zones.get(cell(lat, lon)) ?? null, prefs.photoOffsetH);
      if (!trips.length) {
        say("Konumu ve çekim zamanı olan en az iki fotoğraf gerekli.");
        return;
      }
      const results = [];
      for (const t of trips) {
        const d0 = isoOf(new Date(t[0].t));
        const d1 = isoOf(new Date(t[t.length - 1].t));
        const name = `Fotoğraflardan iz ${d0 === d1 ? isoToTr(d0) : `${isoToTr(d0)} – ${isoToTr(d1)}`}`;
        results.push(await addGpxRecord(name, tripGpx(t, name)));
      }
      const added = addResults(results);
      say(`Fotoğraflardan ${fmtNumber(added.length)} yolculuk kaydı oluşturuldu.`);
      if (added.length) mapRef.current?.fitFiles(added);
    } catch (e) {
      fail(`Fotoğraflardan iz oluşturulamadı: ${e}`);
    }
  }, [photoInfo, prefs.photoOffsetH, addResults, say, fail]);
  // ---------- Gezi hikâyesi, görüntü kaydetme ----------
  const { makeStory, makeTripStory, saveImage } = useStory({ selectedEntry, detail, placedPhotos, places, zones, mapRef, say, fail });
  // ---------- Yedek ve geri yükleme ----------
  const { pwAsk, setPwAsk, backup, restore } = useBackup({ addResults, refreshMeta, setPlacesState, setDialog, say, fail });
  // ---------- Cihazlar arası eşitleme ----------
  const syncFolder = settings?.syncFolder ?? null;
  useArchive({ settings, records: files.length, say, fail });
  const runSync = useSync({ syncFolder, addResults, replaceSummary, forgetPaths, refreshMeta, setPlacesState, setMarks: bookmarks.setMarks, say, fail });

  const { trim, split, merge, openMerge } = useTrackEdits({
    selected,
    detail,
    range,
    multi,
    setMulti,
    setDialog,
    addResults,
    pick,
    say,
    fail,
    refreshMeta,
  });
  const { fitAll, showFlight, findAt, goTo, compareWith, zoomTo, selectAndZoom, startCompare } = useNavigation({
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
  });
  // ---------- Rota planlama ----------
  const savePlan = usePlanRoute({ plan, setPlan, addResults, say, fail, selectAndZoom });

  // ---------- Başlangıç, sürükle-bırak, menü, klavye ----------

  const { dragging } = useStartup({
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
  });

  useMenuHandlers({
    palette: () => !anyModalOpen() && setPalette(true),
    open_files: pickFiles,
    open_folder: pickFolder,
    close_all: closeAll,
    fit_all: fitAll,
    toggle_sidebar: () => up({ sidebarOpen: !prefsRef.current.sidebarOpen }),
    toggle_heatmap: () => up({ heatmap: !prefsRef.current.heatmap }),
    summary: () => setDialog("summary"),
    settings: () => setDialog("settings"),
    export_csv: exportCsv,
    export_png: exportPng,
    export_gpx: exportSelectedGpx,
    merge: openMerge,
    help: () => setDialog("help"),
  });

  const {
    anchor,
    onRowClick,
    setVisible,
    toggle,
    setColor,
    setFilters,
    onGroupBy,
    onToggleGroup,
    onToggleAll,
    openSettings,
    openHelp,
    openGoTo,
    dismissMultiHint,
    openSummary,
    openTag,
    clearMulti,
  } = useListActions({ rows, selected, pick, setMulti, patchFiles, up, prefsRef, filesRef, shownRef, setDialog });

  // Gezi grubunun bütün kayıtlarını seç ve haritada göster.
  const onSelectGroup = useCallback((paths: string[]) => {
    const set = new Set(paths);
    setMulti(set);
    mapRef.current?.fitFiles(filesRef.current.filter((f) => set.has(f.summary.path)));
  }, []);
  // ---------- Haritada yer arama ----------
  // Gezilen ülkeler aramada öne alınır (ör. "Paris": Fransa'ya gidildiyse oradaki).
  const visitedCountries = useMemo(() => {
    const cc = new Set<string>();
    for (const f of files) for (const v of f.summary.visits ?? []) cc.add(v[1]);
    return [...cc];
  }, [files]);
  const mapCenter = useCallback(() => mapRef.current?.center() ?? null, []);

  // ---------- Komut paleti (Ctrl/⌘+K) ----------
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        // Açık bir pencerenin üstünde açılmaz (Esc arkadaki pencereyi kapatırdı).
        if (!anyModalOpen()) setPalette(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const commands = useMemo<Command[]>(
    () =>
      palette
        ? paletteCommands({
            pickFiles,
            pickFolder,
            setDialog,
            openGoTo,
            duplicates: duplicateGroups.length,
            openPlan,
            downloadArea,
            fitAll,
            exportPng,
            exportCsv,
            backup,
            restore,
            sync: syncFolder ? () => void runSync(true) : null,
            prefs,
            up,
            setBaseLayer,
            selected: selectedEntry?.summary ?? null,
            zoomTo,
            exportSelectedGpx,
            makeStory,
            rewrite,
            editPoints: () => {
              setPlan(null);
              setEditMode(true);
            },
            places,
            bookmarks: bookmarks.marks,
            centerOn: (lonLat, zoom) => mapRef.current?.centerOn(lonLat, zoom),
            records: shown.map((f) => f.summary),
            selectAndZoom,
          })
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
    palette,
    prefs,
    selectedEntry,
    places,
    bookmarks.marks,
    shown,
    duplicateGroups,
    backup,
    restore,
    downloadArea,
    exportCsv,
    exportPng,
    exportSelectedGpx,
    fitAll,
    openGoTo,
    pickFiles,
    pickFolder,
    rewrite,
    makeStory,
    selectAndZoom,
    setBaseLayer,
    up,
    zoomTo,
    setDialog,
    syncFolder,
    runSync,
  ]);
  useKeyboard({
    rows,
    selected,
    range,
    multi,
    detail,
    dialog,
    routeModal,
    modalOpen: !!namePrompt,
    areaMode,
    compare,
    pick,
    anchor,
    filesRef,
    setAreaMode,
    setCompare,
    setRange,
    setMulti,
    setDialog,
    setPlaying,
  });

  return (
    <div className={`app${prefs.sidebarOpen ? "" : " sidebar-closed"}`}>
      {isModern && (
        <Rail
          sidebarOpen={prefs.sidebarOpen}
          hasFiles={files.length > 0}
          onToggleSidebar={() => up({ sidebarOpen: !prefs.sidebarOpen })}
          onOpenFiles={pickFiles}
          onOpenFolder={pickFolder}
          onSummary={openSummary}
          onDay={() => setDialog("day")}
          onGoTo={openGoTo}
          onBookmarks={() => setDialog("bookmarks")}
          onPlan={openPlan}
          onPalette={() => setPalette(true)}
          onHelp={openHelp}
          onSettings={openSettings}
        />
      )}
      {prefs.sidebarOpen && (
        <Sidebar
          files={files}
          shown={shown}
          groups={groups}
          groupBy={prefs.groupBy}
          collapsed={collapsed}
          filters={prefs.filters}
          years={years}
          selected={selected}
          multi={multi}
          loading={loading}
          onFilters={setFilters}
          onGroupBy={onGroupBy}
          onToggleGroup={onToggleGroup}
          onSelectGroup={onSelectGroup}
          onRowClick={onRowClick}
          onZoom={selectAndZoom}
          onToggle={toggle}
          onToggleAll={onToggleAll}
          onRemove={removePaths}
          onOpenFiles={pickFiles}
          onOpenFolder={pickFolder}
          onSettings={openSettings}
          onSummary={openSummary}
          onMerge={openMerge}
          onExportCsv={exportCsv}
          onSetVisible={setVisible}
          onClearMulti={clearMulti}
          onHelp={openHelp}
          tzMode={prefs.tzMode}
          multiHintSeen={prefs.multiHintSeen}
          onDismissMultiHint={dismissMultiHint}
          meta={meta}
          allTags={allTags}
          routeLabel={routeLabel}
          areaMode={areaMode}
          onAreaMode={setAreaMode}
          onCompare={startCompare}
          onTagMany={openTag}
          overlaps={overlapInfo}
          places={places}
          onGoTo={openGoTo}
          onDay={() => setDialog("day")}
          duplicateGroups={duplicateGroups.length}
          onDuplicates={() => setDialog("duplicates")}
          onExportFiltered={exportFiltered}
          onExportMulti={exportMulti}
          onTripStory={() => void makeTripStory(files.filter((f) => multi.has(f.summary.path)))}
        />
      )}
      <main className="main">
        <div className="map-wrap">
          <HoverMapView
            ref={mapRef}
            onInfo={say}
            files={onMap}
            pool={files}
            selected={selected}
            detail={detail}
            cursor={cursor}
            onHoverIdx={onHoverIdx}
            range={range}
            trackColorBy={prefs.trackColorBy}
            heatmap={prefs.heatmap}
            followCursor={playing && prefs.follow}
            baseLayer={baseLayer}
            initialView={prefs.mapView}
            onViewChange={(mapView) => up({ mapView })}
            onSelect={(p) => {
              setMulti(new Set());
              setCompare(null);
              pick(p);
            }}
            areaMode={areaMode}
            area={prefs.filters.area}
            onArea={(area) => {
              setAreaMode(false);
              up({ filters: { ...prefsRef.current.filters, area } });
            }}
            stopsLayer={prefs.stopsLayer}
            showGaps={prefs.showGaps}
            highlight={compare}
            cursors={cursors}
            dateWindow={dateWindow}
            places={places}
            onNamePlace={onNamePlace}
            flights={mapFlights}
            regions={regions}
            terrain={prefs.terrain3d}
            customLayers={prefs.customLayers}
            privacyZones={zones}
            explorer={explorer?.geo ?? null}
            plan={plan ? { points: plan.points, line: plan.route?.coords.map(([la, lo]) => [lo, la] as [number, number]) ?? null } : null}
            onPlanAdd={(p) => setPlan((s) => s && { ...s, points: [...s.points, p] })}
            onPlanMove={(i, p) => setPlan((s) => s && { ...s, points: s.points.map((q, k) => (k === i ? p : q)) })}
            onPlanRemove={(i) => setPlan((s) => s && { ...s, points: s.points.filter((_, k) => k !== i) })}
            bookmarks={prefs.bookmarksLayer ? bookmarks.marks : null}
            onBookmark={(b) => setEditMark({ mark: b, isNew: false })}
            onBookmarkHere={([lon, lat]) =>
              setEditMark({ mark: { id: `y${Date.now().toString(36)}`, name: "", note: "", lat, lon, wish: false, created: Date.now() }, isNew: true })
            }
            routePins={routePins}
            editing={editMode && detail && selected ? { detail, idx: editIdx } : null}
            onEditPick={setEditIdx}
            onEditMove={(i, [lon, lat]) =>
              detail &&
              selected &&
              editPoints(selected, () => movePoint(selected, detail.idx[i], lat, lon), "Nokta taşındı.")
            }
            onRoutePoint={(which, p) => {
              const next = { ...routePins, [which]: p };
              setRoutePins(next);
              if (next.a && next.b) setDialog("route");
              else say(which === "a" ? "Başlangıç (A) seçildi; varış yerine sağ tıklayıp “Buraya (B)” seçin." : "Varış (B) seçildi; başlangıç yerine sağ tıklayıp “Buradan (A)” seçin.");
            }}
            onFlight={showFlight}
            photos={mapPhotos}
            summaryOf={summaryOf}
            onPhotoRecord={selectAndZoom}
          />
          <MapToolbar
            prefs={prefs}
            up={up}
            baseLayer={baseLayer}
            setBaseLayer={setBaseLayer}
            files={files}
            libraryFlights={libraryFlights}
            settings={settings}
            applySettings={applySettings}
            fitAll={fitAll}
            exportPng={exportPng}
            placedPhotos={placedPhotos}
            pickPhotos={pickPhotos}
            clearPhotos={clearPhotos}
            photoTrack={makePhotoTracks}
            downloadArea={downloadArea}
            openStreets={() => setDialog("streets")}
            openBookmarks={() => setDialog("bookmarks")}
            openPlan={openPlan}
            search={
              <MapSearch
                places={places}
                bookmarks={bookmarks.marks}
                prefer={visitedCountries}
                center={mapCenter}
                onShow={(h, zoom) => mapRef.current?.showPlace({ lat: h.lat, lon: h.lon, bbox: h.bbox, zoom, label: h.name })}
              />
            }
          />

          {plan && (
            <PlanPanel
              plan={plan}
              onProfile={(profile) => setPlan((s) => s && { ...s, profile })}
              onUndo={() => setPlan((s) => s && { ...s, points: s.points.slice(0, -1) })}
              onClear={() => setPlan((s) => s && { ...s, points: [], route: null })}
              onClose={() => setPlan(null)}
              onSave={savePlan}
            />
          )}
          <OnThisDayCard
            files={files}
            onShow={(paths) => (paths.length === 1 ? selectAndZoom(paths[0]) : onSelectGroup(paths))}
          />
          <MapLegends
            explorer={explorer ? { tiles: explorer.st.tiles.size, square: explorer.st.maxSquare } : null}
            regions={regions}
            heatmap={prefs.heatmap}
            dark={dark}
            dateLegend={dateLegend}
            detail={detail}
            trackColorBy={prefs.trackColorBy}
          />

          {reloading && (
            <div className="reload-overlay" role="status" aria-live="polite">
              <span className="spinner" aria-hidden />
              <span>
                Kayıtlar yeniden hesaplanıyor…
                {loading && loading.total > 0 && ` ${fmtNumber(loading.done)} / ${fmtNumber(loading.total)}`}
              </span>
            </div>
          )}
          <UpdateNotice />
          <Toasts
            undo={undo}
            onUndo={doUndo}
            watchOffer={watchOffer}
            onWatch={() => {
              const s = settingsRef.current;
              if (s && watchOffer) applySettings({ ...s, watchedFolders: [...s.watchedFolders, ...watchOffer] });
              setWatchOffer(null);
            }}
            onDismissWatch={() => setWatchOffer(null)}
            info={info}
            onCloseInfo={() => setInfo(null)}
            duplicates={duplicates}
            onClearDuplicates={() => setDuplicates([])}
            empties={empties}
            onClearEmpties={() => setEmpties([])}
            errors={errors}
            onClearErrors={() => setErrors([])}
          />
        </div>
        {compare && (() => {
          const a = colored.find((f) => f.summary.path === compare[0]);
          const b = colored.find((f) => f.summary.path === compare[1]);
          return a && b ? (
            <CompareView
              a={a}
              b={b}
              detailA={compareDetails[0]}
              detailB={compareDetails[1]}
              height={prefs.panelHeight}
              playSpeed={prefs.playSpeed}
              onPlaySpeed={(playSpeed) => up({ playSpeed })}
              onCursors={setCursors}
              onClose={() => setCompare(null)}
              onFocusPoint={(pt) => mapRef.current?.centerOn(pt, 13)}
            />
          ) : null;
        })()}
        {selectedEntry && !compare && (
          <HoverDetailPanel
            entry={selectedEntry}
            detail={detail}
            detailError={detailError}
            height={prefs.panelHeight}
            onResize={(panelHeight) => up({ panelHeight })}
            metrics={prefs.series}
            onMetrics={(series) => up({ series })}
            xAxis={prefs.xAxis}
            onXAxis={(xAxis) => up({ xAxis })}
            trackColorBy={prefs.trackColorBy}
            onTrackColorBy={(trackColorBy) => up({ trackColorBy })}
            cursor={cursor}
            onHover={onHoverIdx}
            range={range}
            onRange={setRange}
            onPickDay={pickDay}
            rangeStats={rangeSt}
            onZoomRange={zoomRange}
            onTrim={trim}
            onSplit={split}
            playing={playing}
            onPlay={() => setPlaying((v) => !v)}
            playSpeed={prefs.playSpeed}
            onPlaySpeed={(playSpeed) => up({ playSpeed })}
            follow={prefs.follow}
            onFollow={(follow) => up({ follow })}
            onColor={(c) => setColor(selectedEntry.summary.path, c)}
            onClose={() => pick(null)}
            onZoom={() => zoomTo(selectedEntry.summary.path)}
            onExportGpx={exportSelectedGpx}
            onRewrite={(kind) => rewrite(selectedEntry.summary.path, kind)}
            onUndoRewrite={rewritten[selectedEntry.summary.path] ? () => undoRewriteOf(selectedEntry.summary.path) : undefined}
            onDeleteRange={() => {
              const a = range && detail?.idx[range[0]];
              const b = range && detail?.idx[range[1]];
              if (a == null || b == null) return;
              editPoints(selectedEntry.summary.path, () => deletePoints(selectedEntry.summary.path, a, b), "Aralıktaki noktalar silindi.");
            }}
            editMode={editMode}
            onEditMode={() => {
              // Rota planlama ile nokta düzenleme birlikte açık olmaz (tek tıklama ikisine birden gider).
              if (!editMode) setPlan(null);
              setEditMode((v) => !v);
              setEditIdx(null);
            }}
            editIdx={editIdx}
            onDeletePoint={() => {
              const i = editIdx != null ? detail?.idx[editIdx] : undefined;
              if (i == null) return;
              editPoints(selectedEntry.summary.path, () => deletePoints(selectedEntry.summary.path, i, i), "Nokta silindi.");
            }}
            rewriting={rewriting?.path === selectedEntry.summary.path ? rewriting.kind : null}
            meta={meta[selectedEntry.summary.path] ?? EMPTY_META}
            allTags={allTags}
            onMeta={(m) => updateMeta(selectedEntry.summary.path, m)}
            routeCount={routeInfo.byPath.get(selectedEntry.summary.path)?.paths.length ?? 0}
            onOpenRoute={() => setRouteModal(routeInfo.byPath.get(selectedEntry.summary.path) ?? null)}
            overlaps={selOverlaps}
            onCompareWith={(p) => compareWith(selectedEntry.summary.path, p)}
            places={places}
            onNamePlace={onNamePlace}
            onFocusPoint={(pt) => mapRef.current?.centerOn(pt, 15)}
            fuel={prefs.fuel}
            onVideo={() => setDialog("video")}
            onStory={makeStory}
          />
        )}
      </main>

      {dialog === "settings" && settings && (
        <SettingsDialog
          settings={settings}
          prefs={prefs}
          onClose={() => setDialog(null)}
          onPickFolder={async () => {
            const r = await open({ directory: true, multiple: false });
            return typeof r === "string" ? r : null;
          }}
          onSave={async (s, patch, nextPlaces) => {
            setDialog(null);
            up(patch);
            await Promise.all([
              applySettings(s),
              JSON.stringify(nextPlaces) !== JSON.stringify(places) ? updatePlaces(nextPlaces) : null,
            ]);
          }}
          places={places}
          libraryCount={files.length}
          onClearLibrary={() => {
            setDialog(null);
            closeAll();
          }}
          onBackup={backup}
          onRestore={restore}
          onSyncNow={() => runSync(true)}
        />
      )}
      {dialog === "help" && <HelpDialog onClose={() => setDialog(null)} />}
      {dialog === "summary" && (
        <SummaryPanel
          files={shown}
          tzMode={prefs.tzMode}
          from={prefs.filters.from}
          to={prefs.filters.to}
          routes={routeInfo.routes}
          onRoute={(r) => {
            setDialog(null);
            setRouteModal(r);
          }}
          onActivity={(activity) => {
            setDialog(null);
            up({ filters: { ...prefs.filters, activity } });
          }}
          onClose={() => setDialog(null)}
          onSaveImage={saveImage}
          fuel={prefs.fuel}
          goals={prefs.goals}
          onPeriod={(from, to) => {
            setDialog(null);
            up({ filters: { ...prefs.filters, from, to } });
          }}
          onOpen={(p) => {
            setDialog(null);
            selectAndZoom(p);
          }}
          places={places}
          onFlight={showFlight}
        />
      )}
      {dialog === "video" && selectedEntry && detail && (
        <VideoDialog
          onClose={() => setDialog(null)}
          onRecord={async (seconds, onProgress, signal) => {
            const s = selectedEntry.summary;
            try {
              const blob = await mapRef.current!.recordVideo(detail, {
                seconds,
                title: s.name || s.fileName,
                tz: tzOf(s),
                color: "#e8553d",
                onProgress,
                signal,
              });
              const ext = blob.type.includes("mp4") ? "mp4" : "webm";
              const stem = (s.name || s.fileName).replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]+/g, "_");
              const path = await pickSavePath(`${stem}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
              if (!path) return;
              await writeBase64File(path, await blobToBase64(blob));
              setDialog(null);
              say("Video kaydedildi.");
            } catch (e) {
              if ((e as Error)?.name !== "AbortError") fail(`Video kaydedilemedi: ${e}`);
            }
          }}
        />
      )}
      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
      {pwAsk && <PasswordModal ask={pwAsk} onDone={() => setPwAsk(null)} />}
      {editMark && (
        <BookmarkEditor
          mark={editMark.mark}
          onClose={() => setEditMark(null)}
          onSave={(b) => {
            bookmarks.upsert(b);
            setEditMark(null);
            if (!prefs.bookmarksLayer) up({ bookmarksLayer: true });
          }}
          onDelete={
            editMark.isNew
              ? undefined
              : () => {
                  bookmarks.remove(editMark.mark.id);
                  setEditMark(null);
                }
          }
        />
      )}
      {dialog === "streets" && (
        <StreetsDialog
          bounds={() => mapRef.current?.bounds() ?? null}
          onClose={() => setDialog(null)}
          onDone={(m) => {
            setDialog(null);
            say(m);
          }}
        />
      )}
      {dialog === "bookmarks" && (
        <BookmarkList
          marks={bookmarks.marks}
          files={files.map((f) => f.summary)}
          onGo={(b) => {
            setDialog(null);
            mapRef.current?.centerOn([b.lon, b.lat], 13);
          }}
          onEdit={(b) => setEditMark({ mark: b, isNew: false })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "route" && routePins.a && routePins.b && (
        <RouteSearchDialog
          files={shown.map((f) => f.summary)}
          a={routePins.a}
          b={routePins.b}
          places={places}
          onSwap={() => setRoutePins({ a: routePins.b, b: routePins.a })}
          onOpen={(p) => {
            setDialog(null);
            setRoutePins({ a: null, b: null });
            selectAndZoom(p);
          }}
          onClose={() => {
            setDialog(null);
            setRoutePins({ a: null, b: null });
          }}
        />
      )}
      {dialog === "day" && (
        <DayDialog
          files={shown.map((f) => f.summary)}
          places={places}
          initialDay={initialDay}
          daysWithData={daysWithData}
          onFocus={(pt) => {
            setDialog(null);
            mapRef.current?.centerOn(pt, 15);
          }}
          onShowDay={(day) => {
            setDialog(null);
            up({ filters: { ...prefs.filters, from: day, to: day } });
          }}
          onOpen={(p) => {
            setDialog(null);
            selectAndZoom(p);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "goto" && (
        <GoToDialog
          find={findAt}
          summaryOf={summaryOf}
          onGo={goTo}
          onClose={() => setDialog(null)}
        />
      )}
      {namePrompt && (
        <PromptModal
          title={namePrompt.place ? "Yerin adını değiştir" : "Bu yere ad ver"}
          label={`Ad (ör. Ev, İş) · ${namePrompt.lat.toFixed(5)}, ${namePrompt.lon.toFixed(5)}`}
          initial={namePrompt.place?.name ?? ""}
          okLabel="Kaydet"
          onOk={namePlace}
          onClose={() => setNamePrompt(null)}
        />
      )}
      {dialog === "tag" && (
        <PromptModal
          title={`${multi.size} kayda etiket ekle`}
          label="Etiket"
          initial=""
          okLabel="Ekle"
          onOk={tagMany}
          onClose={() => setDialog(null)}
        />
      )}
      {routeModal && (
        <RouteModal
          route={routeModal}
          files={coloredByPath}
          current={selected}
          onOpen={(p) => {
            setRouteModal(null);
            selectAndZoom(p);
          }}
          onFilter={() => {
            up({ filters: { ...prefs.filters, route: routeModal.id } });
            setRouteModal(null);
          }}
          onClose={() => setRouteModal(null)}
        />
      )}
      {dialog === "duplicates" && (
        <DuplicatesDialog
          groups={duplicateGroups}
          files={fileMap}
          onOpen={(p) => {
            setDialog(null);
            selectAndZoom(p);
          }}
          onRemove={(paths) => {
            setDialog(null);
            removePaths(paths);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "merge" && (
        <PromptModal
          title={`${multi.size} kaydı birleştir`}
          label="Yeni kaydın adı"
          initial={`Birleştirilmiş kayıt (${multi.size})`}
          okLabel="Birleştir"
          onOk={merge}
          onClose={() => setDialog(null)}
        />
      )}
      {dragging && (
        <div className="drop-overlay">
          <div>GPX, FIT, TCX, KML, Google konum geçmişi (JSON) dosyalarını, klasörleri ya da fotoğrafları bırakın</div>
        </div>
      )}
    </div>
  );
}
