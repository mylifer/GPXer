import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  backupLibrary,
  fixElevation,
  getMeta,
  getPlaces,
  pickSavePath,
  restoreLibrary,
  snapToRoads,
  undoRewrite,
  writeBase64File,
  type LoadResult,
  type RewriteKind,
} from "./api";
import type { MapHandle } from "./components/MapView";
import { Sidebar } from "./components/Sidebar";
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
import { HoverDetailPanel, HoverMapView } from "./components/HoverViews";
import { MapToolbar } from "./components/MapToolbar";
import { MapLegends } from "./components/MapLegends";
import { Toasts } from "./components/Toasts";
import type { Route } from "./routes";
import { fmtBytes, fmtDistance, fmtElevation, fmtNumber, type TzMode } from "./format";
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

/*
 * Uygulama: durum ve iş mantığı src/hooks altındaki kancalarda; burada
 * birleştirilip arayüze bağlanır. Kancaların çağrılma sırası efektlerin
 * çalışma sırasını belirler; sırayı değiştirirken dikkat.
 */
export default function App() {
  const { prefs, prefsRef, persistedSel, up } = usePrefs();
  const [baseLayer, setBaseLayer] = useBaseLayer();
  const { errors, setErrors, duplicates, setDuplicates, empties, setEmpties, info, setInfo, say, fail } = useNotices();

  const [multi, setMulti] = useState<Set<string>>(new Set());
  /** İmleç (fare ya da oynatma); App'i her karede yeniden çizmemek için state değil. */
  const [cursor] = useState(createIdxStore);
  const [dialog, setDialog] = useState<Dialog>(null);
  // Yerinde düzeltilen kayıtlar (geri almak için önceki halin yolu) ve süren işlem.
  const [detailRev, setDetailRev] = useState(0);
  const [rewritten, setRewritten] = useState<Record<string, string>>({});
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
  const regions = useRegions(shown, prefs.filters.from, prefs.filters.to, prefs.regionsLayer);
  /** Aynı yolculuğun kopyaları (tüm kütüphanede). */
  const duplicateGroups = useMemo(() => findDuplicates(files.map((f) => f.summary)), [files]);
  const fileMap = useMemo(() => new Map(files.map((f) => [f.summary.path, f])), [files]);
  const { setPhotoInfo, placedPhotos, mapPhotos, pickPhotos, clearPhotos, addPhotosRef } = usePhotos({
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
  const rewrite = useCallback(
    async (path: string, kind: RewriteKind) => {
      setRewriting({ path, kind });
      try {
        const r = await (kind === "elevation" ? fixElevation(path) : snapToRoads(path));
        replaceSummary(r.result);
        setRewritten((m) => ({ ...m, [path]: r.previous }));
        setDetailRev((x) => x + 1);
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
    [replaceSummary, say, fail],
  );
  const undoRewriteOf = useCallback(
    async (path: string) => {
      const prev = rewritten[path];
      if (!prev) return;
      try {
        replaceSummary(await undoRewrite(path, prev));
        setRewritten((m) => {
          const n = { ...m };
          delete n[path];
          return n;
        });
        setDetailRev((x) => x + 1);
        say("Kaydın düzeltmeden önceki haline dönüldü.");
      } catch (e) {
        fail(String(e));
      }
    },
    [rewritten, replaceSummary, say, fail],
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
  const backup = useCallback(async () => {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const dest = await pickSavePath(`GPXer-yedek-${day}.zip`, [{ name: "GPXer yedeği", extensions: ["zip"] }]);
      if (!dest) return;
      const path = /\.zip$/i.test(dest) ? dest : `${dest}.zip`;
      const r = await backupLibrary(path).catch(() => backupLibrary(dest));
      say(`${fmtNumber(r.records)} kayıt yedeklendi (${fmtBytes(r.bytes)}).`);
    } catch (e) {
      fail(String(e));
    }
  }, [say, fail]);
  const restore = useCallback(async () => {
    try {
      const src = await open({ multiple: false, filters: [{ name: "GPXer yedeği", extensions: ["zip"] }] });
      if (typeof src !== "string") return;
      setDialog(null);
      say("Yedek geri yükleniyor…");
      const r = await restoreLibrary(src);
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
          duplicateGroups={duplicateGroups.length}
          onDuplicates={() => setDialog("duplicates")}
          onExportFiltered={exportFiltered}
          onExportMulti={exportMulti}
        />
      )}
      <main className="main">
        <div className="map-wrap">
          <HoverMapView
            ref={mapRef}
            onInfo={say}
            files={onMap}
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
          />

          <MapLegends
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
          />
        )}
      </main>

      {dialog === "settings" && settings && (
        <SettingsDialog
          settings={settings}
          tzMode={prefs.tzMode}
          onClose={() => setDialog(null)}
          onPickFolder={async () => {
            const r = await open({ directory: true, multiple: false });
            return typeof r === "string" ? r : null;
          }}
          onSave={(s, tzMode: TzMode, nextPlaces) => {
            setDialog(null);
            up({ tzMode });
            applySettings(s);
            if (JSON.stringify(nextPlaces) !== JSON.stringify(places)) updatePlaces(nextPlaces);
          }}
          places={places}
          libraryCount={files.length}
          onClearLibrary={() => {
            setDialog(null);
            closeAll();
          }}
          onBackup={backup}
          onRestore={restore}
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
