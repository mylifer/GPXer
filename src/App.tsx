import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import {
  exportAs,
  expandPaths,
  getMeta,
  setMeta as saveMeta,
  flushCache,
  getSettings,
  libraryFiles,
  loadDetail,
  loadFiles,
  mergeFiles,
  rangeStats,
  removeFiles,
  restoreFiles,
  setSettings as saveSettings,
  splitFile,
  takePendingPaths,
  trimFile,
  writeBase64File,
  writeTextFile,
  type Detail,
  type ExportFormat,
  type FileMeta,
  type LoadResult,
  type Settings,
  type Stats,
  type TrashItem,
} from "./api";
import { BASE_LAYERS, MapView, metricDomain, type BaseLayer, type MapHandle } from "./components/MapView";
import { Sidebar, type Group, type RowModifiers } from "./components/Sidebar";
import { DetailPanel } from "./components/DetailPanel";
import { UpdateNotice } from "./components/UpdateNotice";
import { SettingsDialog } from "./components/SettingsDialog";
import { SummaryPanel } from "./components/SummaryPanel";
import { PromptModal } from "./components/Modal";
import { RouteModal } from "./components/RouteModal";
import { CompareView, type Cursor } from "./components/CompareView";
import { findRoutes, type Route } from "./routes";
import { linesHitBox } from "./geo";
import { METRICS, SEQ_DARK, SEQ_LIGHT, defaultColor, placeLabel, rampColor, type FileEntry } from "./types";
import { loadPrefs, savePrefs, type Filters, type Prefs } from "./prefs";
import { dayKey, fmtDate, fmtNumber, fmtUnit, monthLabel, setTzMode, tzOf, type TzMode } from "./format";
import { csvFor } from "./csv";

/** Tek seferde Rust tarafına gönderilen dosya sayısı; ilerleme çubuğunun
 * akıcı güncellenmesi için küçük tutulur. */
const CHUNK = 24;
const UNDO_MS = 12_000;

interface LoadError {
  path: string;
  message: string;
}

interface Duplicate {
  path: string;
  /** Kütüphanedeki aynı içerikli dosyanın adı. */
  existing: string;
}

interface OpenOptions {
  /** Kopya bildirimleri gösterilmesin (kütüphane, izlenen klasörler). */
  quiet?: boolean;
  /** Yükleme bitince haritayı yeni kayıtlara yakınlaştırma. */
  noFit?: boolean;
  /** Tek kayıt eklendiğinde onu seçme. */
  noSelect?: boolean;
  /** "Yeni kayıt eklendi" bildirimi gösterilmesin. */
  silent?: boolean;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const EMPTY_META: FileMeta = { tags: [], note: "", activity: null };
const OPEN_EXTS = ["gpx", "GPX", "fit", "FIT", "tcx", "TCX", "kml", "KML"];

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const up = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);
  setTzMode(prefs.tzMode);

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(prefs.selected);
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  const [rangeSt, setRangeSt] = useState<Stats | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<LoadError[]>([]);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ items: TrashItem[]; count: number } | null>(null);
  const [watchOffer, setWatchOffer] = useState<string[] | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);
  const [dialog, setDialog] = useState<"settings" | "summary" | "merge" | "tag" | null>(null);
  const [meta, setMetaState] = useState<Record<string, FileMeta>>({});
  const [areaMode, setAreaMode] = useState(false);
  const [compare, setCompare] = useState<[string, string] | null>(null);
  const [compareDetails, setCompareDetails] = useState<[Detail | null, Detail | null]>([null, null]);
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [routeModal, setRouteModal] = useState<Route | null>(null);
  const [dragging, setDragging] = useState(false);
  const [baseLayer, setBaseLayer] = useState<BaseLayer>(() => {
    try {
      const v = localStorage.getItem("baseLayer.v2") as BaseLayer | null;
      return v && BASE_LAYERS.some((l) => l.id === v) ? v : "light";
    } catch {
      return "light";
    }
  });

  const mapRef = useRef<MapHandle>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const loadQueue = useRef<Promise<void>>(Promise.resolve());
  const initialLoad = useRef(true);
  /** Açılışta kayıtlı bir harita konumu var mıydı (harita kendi ilk konumunu da kaydeder). */
  const hadView = useRef(prefs.mapView != null);

  useEffect(() => {
    try {
      localStorage.setItem("baseLayer.v2", baseLayer);
    } catch {
      /* önemli değil */
    }
  }, [baseLayer]);
  useEffect(() => up({ selected }), [selected, up]);

  const say = useCallback((msg: string) => {
    setInfo(msg);
    setTimeout(() => setInfo((m) => (m === msg ? null : m)), 5000);
  }, []);
  const fail = useCallback((message: string, path = "") => setErrors((prev) => [...prev, { path, message }]), []);

  // ---------- Türetilen veriler ----------

  const dark = baseLayer === "dark" || baseLayer === "satellite";

  /** Tarihe göre renk kipinde her dosyanın rengi. */
  const colored = useMemo(() => {
    if (prefs.colorMode !== "date") return files;
    const dated = files
      .filter((f) => f.summary.stats.startTime != null)
      .sort((a, b) => a.summary.stats.startTime! - b.summary.stats.startTime!);
    const rank = new Map(dated.map((f, i) => [f.summary.path, dated.length > 1 ? i / (dated.length - 1) : 1]));
    const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
    return files.map((f) => {
      const t = rank.get(f.summary.path);
      return { ...f, color: t == null ? "#9aa1a8" : rampColor(ramp, t) };
    });
  }, [files, prefs.colorMode, dark]);

  /** Tekrarlanan güzergâhlar (tüm kütüphane üzerinden). */
  const routeInfo = useMemo(() => findRoutes(files), [files]);

  const allTags = useMemo(
    () => [...new Set(Object.values(meta).flatMap((m) => m.tags))].sort((a, b) => a.localeCompare(b, "tr-TR")),
    [meta],
  );

  const shown = useMemo(() => {
    const fl = prefs.filters;
    const q = fl.query.trim().toLocaleLowerCase("tr-TR");
    const dateOn = !!(fl.from || fl.to);
    const list = colored.filter((f) => {
      const s = f.summary;
      const m = meta[s.path];
      if (q) {
        const hay = `${s.name ?? ""} ${s.fileName} ${s.startPlace ?? ""} ${s.endPlace ?? ""} ${m?.tags.join(" ") ?? ""} ${m?.note ?? ""}`;
        if (!hay.toLocaleLowerCase("tr-TR").includes(q)) return false;
      }
      if (fl.activity && s.activity !== fl.activity) return false;
      if (fl.tag && !m?.tags.includes(fl.tag)) return false;
      if (fl.route && routeInfo.byPath.get(s.path)?.id !== fl.route) return false;
      if (fl.area && !linesHitBox(s.lines, fl.area, s.stats.bbox)) return false;
      if (!dateOn) return true;
      const t = s.stats.startTime;
      if (t == null) return fl.includeUndated;
      const day = dayKey(t, tzOf(s));
      if (fl.from && day < fl.from) return false;
      if (fl.to && day > fl.to) return false;
      return true;
    });
    // Tarihsiz kayıtlar tarih sıralamasında her zaman en sonda.
    const byDate = (a: FileEntry, b: FileEntry, dir: number) => {
      const ta = a.summary.stats.startTime;
      const tb = b.summary.stats.startTime;
      if (ta == null || tb == null) return ta == null ? (tb == null ? 0 : 1) : -1;
      return (ta - tb) * dir;
    };
    const byName = (a: FileEntry, b: FileEntry) =>
      (a.summary.name || a.summary.fileName).localeCompare(b.summary.name || b.summary.fileName, "tr-TR", {
        numeric: true,
      });
    switch (fl.sort) {
      case "date-desc":
        return list.sort((a, b) => byDate(a, b, -1));
      case "date-asc":
        return list.sort((a, b) => byDate(a, b, 1));
      case "name":
        return list.sort(byName);
      case "distance":
        return list.sort((a, b) => b.summary.stats.distanceM - a.summary.stats.distanceM);
    }
  }, [colored, prefs.filters, meta, routeInfo]);

  const groups = useMemo<Group[]>(() => {
    if (prefs.groupBy === "none") return [];
    const map = new Map<string, Group>();
    for (const f of shown) {
      const t = f.summary.stats.startTime;
      const key =
        t == null ? "undated" : prefs.groupBy === "month" ? dayKey(t, tzOf(f.summary)).slice(0, 7) : dayKey(t, tzOf(f.summary)).slice(0, 4);
      let g = map.get(key);
      if (!g) {
        const label = key === "undated" ? "Tarihsiz" : prefs.groupBy === "month" ? monthLabel(key) : key;
        g = { key, label, items: [], distanceM: 0, movingMs: 0 };
        map.set(key, g);
      }
      g.items.push(f);
      g.distanceM += f.summary.stats.distanceM;
      g.movingMs += f.summary.stats.movingMs ?? 0;
    }
    return [...map.values()];
  }, [shown, prefs.groupBy]);

  const collapsed = useMemo(() => new Set(prefs.collapsed), [prefs.collapsed]);

  /** Listede görünen satırlar, ekrandaki sırayla (klavye ve Shift+tık için). */
  const rows = useMemo(
    () =>
      prefs.groupBy === "none" ? shown : groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.items)),
    [shown, groups, collapsed, prefs.groupBy],
  );

  const years = useMemo(() => {
    const ys = new Set<number>();
    for (const f of files) {
      const t = f.summary.stats.startTime;
      if (t != null) ys.add(Number(dayKey(t, tzOf(f.summary)).slice(0, 4)));
    }
    return [...ys].sort((a, b) => b - a);
  }, [files, prefs.tzMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMap = useMemo(() => shown.filter((f) => f.visible), [shown]);
  const selectedEntry = useMemo(
    () => (selected ? (colored.find((f) => f.summary.path === selected) ?? null) : null),
    [colored, selected],
  );

  // ---------- Seçili kayıt ----------

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setHoverIdx(null);
    setRange(null);
    setPlaying(false);
    if (!selected) return;
    let cancelled = false;
    loadDetail(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setDetailError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Karşılaştırılan iki kaydın grafik verisi.
  useEffect(() => {
    setCompareDetails([null, null]);
    setCursors([]);
    if (!compare) return;
    let cancelled = false;
    Promise.all(compare.map((p) => loadDetail(p)))
      .then(([a, b]) => !cancelled && setCompareDetails([a, b]))
      .catch((e) => !cancelled && setErrors((prev) => [...prev, { path: "", message: String(e) }]));
    return () => {
      cancelled = true;
    };
  }, [compare]);

  // Seçili aralığın tam çözünürlüklü istatistiği.
  useEffect(() => {
    setRangeSt(null);
    if (!range || !detail || !selected) return;
    const [a, b] = [detail.idx[range[0]], detail.idx[range[1]]];
    let cancelled = false;
    const t = setTimeout(() => {
      rangeStats(selected, a, b)
        .then((s) => !cancelled && setRangeSt(s))
        .catch(() => {});
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [range, detail, selected]);

  // Oynatma: imleci kaydın gerçek zamanına göre (hızlandırılmış) ilerletir.
  useEffect(() => {
    if (!playing || !detail || detail.lat.length < 2) return;
    const n = detail.lat.length;
    const times = detail.time;
    const timed = times.every((t, i) => t != null && (i === 0 || t >= times[i - 1]!));
    let i0 = hoverIdx != null && hoverIdx < n - 1 ? hoverIdx : 0;
    const startVal = timed ? times[i0]! : detail.dist[i0];
    const endVal = timed ? times[n - 1]! : detail.dist[n - 1];
    const speed = prefsRef.current.playSpeed;
    let raf = 0;
    let t0: number | null = null;
    const step = (now: number) => {
      t0 ??= now;
      const elapsed = now - t0;
      // Zamansız kayıtlarda 15 km/sa varsayılır.
      const v = startVal + (timed ? elapsed * speed : ((elapsed * speed) / 1000) * 4.17);
      while (i0 < n - 1 && (timed ? times[i0 + 1]! : detail.dist[i0 + 1]) <= v) i0++;
      setHoverIdx(i0);
      if (v >= endVal) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, detail]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Yükleme ----------

  const entryFor = useCallback(
    (file: FileEntry["summary"]): FileEntry => ({
      summary: file,
      color: prefsRef.current.colors[file.path] ?? defaultColor(file.path),
      visible: !prefsRef.current.hidden.includes(file.path),
    }),
    [],
  );

  const openPaths = useCallback(
    (paths: string[], opts: OpenOptions = {}) => {
      if (paths.length === 0) return loadQueue.current;
      // Birden fazla açma isteği üst üste gelirse sırayla işlenir.
      loadQueue.current = loadQueue.current
        .then(async () => {
          const expanded = await expandPaths(paths);
          const known = new Set(filesRef.current.map((f) => f.summary.path));
          const todo = expanded.filter((p) => !known.has(p));
          if (todo.length === 0) {
            // Zaten açık tek bir dosya tekrar açıldıysa onu seç.
            if (expanded.length === 1 && !opts.noSelect) setSelected(expanded[0]);
            return;
          }
          const wasEmpty = filesRef.current.length === 0;
          const added: FileEntry[] = [];
          const newErrors: LoadError[] = [];
          const newDuplicates: Duplicate[] = [];
          const existingOf = (path: string) => {
            const f = [...filesRef.current, ...added].find((x) => x.summary.path === path);
            return f ? f.summary.name || f.summary.fileName : baseName(path);
          };
          setLoading({ done: 0, total: todo.length });
          for (let i = 0; i < todo.length; i += CHUNK) {
            const results = await loadFiles(todo.slice(i, i + CHUNK));
            const batch: FileEntry[] = [];
            for (const r of results) {
              if (r.status === "ok") {
                if (!known.has(r.file.path)) {
                  known.add(r.file.path);
                  batch.push(entryFor(r.file));
                }
              } else if (r.status === "duplicate") {
                newDuplicates.push({ path: r.path, existing: existingOf(r.existing) });
                // Tek bir dosya açıldıysa ve zaten kütüphanedeyse onu seç.
                if (todo.length === 1 && !opts.noSelect) setSelected(r.existing);
              } else {
                newErrors.push({ path: r.path, message: r.message });
              }
            }
            added.push(...batch);
            setFiles((prev) => [...prev, ...batch]);
            setLoading({ done: Math.min(todo.length, i + CHUNK), total: todo.length });
          }
          setLoading(null);
          flushCache().catch(() => {});
          if (newErrors.length) setErrors((prev) => [...prev, ...newErrors]);
          if (newDuplicates.length && !opts.quiet) setDuplicates((prev) => [...prev, ...newDuplicates]);
          if (added.length === 1 && !opts.noSelect) setSelected(added[0].summary.path);
          if (added.length > 0 && !opts.noFit) {
            // İlk yüklemede hepsini, sonradan eklemede yalnızca yenileri göster.
            requestAnimationFrame(() => mapRef.current?.fitFiles(wasEmpty ? filesRef.current : added));
          }
          if (opts.quiet && !opts.silent && added.length > 0 && !initialLoad.current) {
            say(`${fmtNumber(added.length)} yeni kayıt kütüphaneye eklendi.`);
          }
        })
        .catch((e) => {
          setLoading(null);
          fail(String(e));
        });
      return loadQueue.current;
    },
    [entryFor, fail, say],
  );

  /** Yeni oluşturulan kayıtları (kırpma, bölme, birleştirme) listeye ekler. */
  const addResults = useCallback(
    (results: LoadResult[]) => {
      const added: FileEntry[] = [];
      for (const r of results) {
        if (r.status === "ok") added.push(entryFor(r.file));
        else if (r.status === "error") fail(r.message, r.path);
        else say(`Bu kayıt zaten kütüphanede: ${baseName(r.existing)}`);
      }
      if (added.length) {
        setFiles((prev) => [...prev, ...added]);
        flushCache().catch(() => {});
      }
      return added;
    },
    [entryFor, fail, say],
  );

  const pickFiles = useCallback(async () => {
    const res = await open({
      multiple: true,
      filters: [{ name: "İz dosyaları (GPX, FIT, TCX, KML)", extensions: OPEN_EXTS }],
    });
    if (res) openPaths(Array.isArray(res) ? res : [res]);
  }, [openPaths]);

  const pickFolder = useCallback(async () => {
    const res = await open({ directory: true, multiple: true });
    if (!res) return;
    const folders = Array.isArray(res) ? res : [res];
    openPaths(folders);
    const watched = new Set(settingsRef.current?.watchedFolders ?? []);
    const offer = folders.filter((f) => !watched.has(f));
    if (offer.length) setWatchOffer(offer);
  }, [openPaths]);

  const applySettings = useCallback(
    async (next: Settings) => {
      const prev = settingsRef.current;
      setSettingsState(next);
      try {
        const problems = await saveSettings(next);
        problems.forEach((m) => fail(m));
      } catch (e) {
        fail(String(e));
        setSettingsState(prev);
        return;
      }
      const statsChanged =
        !prev ||
        prev.stats.movingSpeedMs !== next.stats.movingSpeedMs ||
        prev.stats.elevationThresholdM !== next.stats.elevationThresholdM ||
        prev.stats.cleanSpikes !== next.stats.cleanSpikes ||
        prev.stats.perType !== next.stats.perType;
      if (statsChanged) {
        // İstatistikleri yeni eşiklerle yeniden hesapla.
        setFiles([]);
        const lib = await libraryFiles();
        openPaths(lib, { quiet: true, noFit: true, noSelect: true });
        const sel = selected;
        setSelected(null);
        loadQueue.current.then(() => setSelected(sel));
      }
      const newFolders = next.watchedFolders.filter((f) => !prev?.watchedFolders.includes(f));
      if (newFolders.length) openPaths(newFolders, { quiet: true, noSelect: true });
    },
    [fail, openPaths, selected],
  );

  const removePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const set = new Set(paths);
      try {
        const items = await removeFiles(paths);
        setUndo({ items, count: paths.length });
      } catch (e) {
        fail(String(e));
      }
      setFiles((prev) => prev.filter((f) => !set.has(f.summary.path)));
      setSelected((s) => (s && set.has(s) ? null : s));
      setMulti((m) => new Set([...m].filter((p) => !set.has(p))));
    },
    [fail],
  );

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  const doUndo = useCallback(async () => {
    if (!undo) return;
    setUndo(null);
    const restored = await restoreFiles(undo.items);
    await openPaths(restored, { quiet: true, silent: true, noFit: true, noSelect: restored.length !== 1 });
    say(`${fmtNumber(restored.length)} kayıt geri getirildi.`);
  }, [undo, openPaths, say]);

  const closeAll = useCallback(async () => {
    const all = filesRef.current.map((f) => f.summary.path);
    if (all.length === 0) return;
    const ok = await ask(
      `Kütüphanedeki ${all.length} kaydın tamamı kaldırılsın mı? Orijinal dosyalarınız etkilenmez; hemen ardından “Geri al” ile geri getirebilirsiniz.`,
      { title: "Kütüphaneyi temizle", kind: "warning", okLabel: "Temizle", cancelLabel: "Vazgeç" },
    );
    if (!ok) return;
    await removePaths(all);
    setErrors([]);
    setDuplicates([]);
  }, [removePaths]);

  const fitAll = useCallback(() => {
    mapRef.current?.fitFiles(filesRef.current.filter((f) => f.visible));
  }, []);

  // ---------- Dışa aktarma ve düzenleme ----------

  const exportCsv = useCallback(async () => {
    const list = multi.size > 1 ? shown.filter((f) => multi.has(f.summary.path)) : shown;
    if (list.length === 0) return;
    const path = await save({ defaultPath: "gpxer-ozet.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    if (!path) return;
    try {
      await writeTextFile(path, csvFor(list, meta));
      say(`${fmtNumber(list.length)} kaydın özeti kaydedildi.`);
    } catch (e) {
      fail(String(e));
    }
  }, [multi, shown, say, fail, meta]);

  const exportPng = useCallback(async () => {
    try {
      const data = await mapRef.current!.exportPng();
      const path = await save({ defaultPath: "gpxer-harita.png", filters: [{ name: "PNG", extensions: ["png"] }] });
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
    const path = await save({
      defaultPath: f.summary.fileName,
      filters: [
        { name: "GPX", extensions: ["gpx"] },
        { name: "KML (Google Earth)", extensions: ["kml"] },
        { name: "TCX (Garmin)", extensions: ["tcx"] },
      ],
    });
    if (!path) return;
    const ext = path.split(".").pop()?.toLowerCase();
    const format: ExportFormat = ext === "kml" || ext === "tcx" ? ext : "gpx";
    try {
      await exportAs(f.summary.path, path, format);
      say(`${format.toUpperCase()} dosyası kaydedildi.`);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, say, fail]);

  const trim = useCallback(async () => {
    if (!selected || !detail || !range) return;
    try {
      const added = addResults([await trimFile(selected, detail.idx[range[0]], detail.idx[range[1]])]);
      if (added[0]) setSelected(added[0].summary.path);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, detail, range, addResults, fail]);

  const split = useCallback(async () => {
    if (!selected || !detail || !range) return;
    try {
      const added = addResults(await splitFile(selected, detail.idx[range[0]]));
      if (added.length === 2) say("Kayıt ikiye bölündü; iki yeni kayıt eklendi (orijinal duruyor).");
      if (added[1]) setSelected(added[1].summary.path);
    } catch (e) {
      fail(String(e));
    }
  }, [selected, detail, range, addResults, fail, say]);

  const merge = useCallback(
    async (name: string) => {
      setDialog(null);
      const paths = shown.filter((f) => multi.has(f.summary.path)).map((f) => f.summary.path);
      try {
        const added = addResults([await mergeFiles(paths, name)]);
        if (added[0]) {
          setMulti(new Set());
          setSelected(added[0].summary.path);
          say(`${paths.length} kayıt birleştirildi (orijinaller duruyor).`);
        }
      } catch (e) {
        fail(String(e));
      }
    },
    [shown, multi, addResults, say, fail],
  );

  const openMerge = useCallback(() => {
    if (multi.size < 2) {
      say("Birleştirmek için listede Ctrl/⌘ ile tıklayarak en az iki kayıt seçin.");
      return;
    }
    setDialog("merge");
  }, [multi, say]);

  // ---------- Başlangıç, sürükle-bırak, menü ----------

  useEffect(() => {
    const unlisten: Promise<() => void>[] = [];
    const drainPending = () => takePendingPaths().then((p) => openPaths(p));

    unlisten.push(
      getCurrentWebview().onDragDropEvent((e) => {
        const t = e.payload.type;
        if (t === "enter" || t === "over") setDragging(true);
        else if (t === "leave") setDragging(false);
        else if (t === "drop") {
          setDragging(false);
          openPaths(e.payload.paths);
        }
      }),
    );
    unlisten.push(listen("pending-paths", drainPending));
    unlisten.push(listen<string[]>("watched-paths", (e) => openPaths(e.payload, { quiet: true, noFit: true, noSelect: true })));
    return () => unlisten.forEach((p) => p.then((fn) => fn()));
  }, [openPaths]);

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
      await openPaths(await libraryFiles(), { quiet: true, noFit: hadView.current, noSelect: true });
      if (s?.watchedFolders.length) await openPaths(s.watchedFolders, { quiet: true, noFit: true, noSelect: true });
      initialLoad.current = false;
      // Kayıtlı seçim artık yoksa bırak.
      setSelected((sel) => (sel && filesRef.current.some((f) => f.summary.path === sel) ? sel : null));
      await openPaths(await takePendingPaths());
    })();
    return () => {
      done = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handlers = useRef<Record<string, () => void>>({});
  handlers.current = {
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
  };
  useEffect(() => {
    const u = listen<string>("menu", (e) => handlers.current[e.payload]?.());
    return () => {
      u.then((fn) => fn());
    };
  }, []);

  // ---------- Liste etkileşimi ----------

  const onRowClick = useCallback(
    (path: string, mods: RowModifiers) => {
      if (mods.range && anchor.current) {
        const order = rows.map((f) => f.summary.path);
        const a = order.indexOf(anchor.current);
        const b = order.indexOf(path);
        if (a >= 0 && b >= 0) {
          setMulti(new Set(order.slice(Math.min(a, b), Math.max(a, b) + 1)));
          return;
        }
      }
      if (mods.toggle) {
        setMulti((m) => {
          const next = new Set(m);
          if (next.size === 0 && selected) next.add(selected);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        anchor.current = path;
        return;
      }
      setMulti(new Set());
      anchor.current = path;
      setSelected(path);
    },
    [rows, selected],
  );

  // Klavye: Esc, ↑/↓, Boşluk.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (dialog) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") {
        if (areaMode) setAreaMode(false);
        else if (compare) setCompare(null);
        else if (range) setRange(null);
        else if (multi.size) setMulti(new Set());
        else setSelected(null);
      }
      if (e.key === " " && detail && tag !== "BUTTON") {
        e.preventDefault();
        setPlaying((v) => !v);
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = rows.findIndex((f) => f.summary.path === selected);
        const next = e.key === "ArrowDown" ? idx + 1 : idx < 0 ? rows.length - 1 : idx - 1;
        const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
        if (target) {
          setSelected(target.summary.path);
          anchor.current = target.summary.path;
          document
            .querySelector(`.file-row[data-path="${CSS.escape(target.summary.path)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selected, range, multi, detail, dialog, areaMode, compare]);

  const zoomTo = useCallback((path: string) => {
    const f = filesRef.current.find((x) => x.summary.path === path);
    if (f) mapRef.current?.fitFiles([f]);
  }, []);

  const selectAndZoom = useCallback(
    (path: string) => {
      setSelected(path);
      zoomTo(path);
    },
    [zoomTo],
  );

  const setVisible = useCallback(
    (paths: string[], visible: boolean) => {
      const ids = new Set(paths);
      setFiles((prev) => prev.map((f) => (ids.has(f.summary.path) ? { ...f, visible } : f)));
      const hidden = new Set(prefsRef.current.hidden);
      for (const p of paths) {
        if (visible) hidden.delete(p);
        else hidden.add(p);
      }
      up({ hidden: [...hidden] });
    },
    [up],
  );

  const toggle = useCallback(
    (path: string) => {
      const f = filesRef.current.find((x) => x.summary.path === path);
      if (f) setVisible([path], !f.visible);
    },
    [setVisible],
  );

  const setColor = useCallback(
    (path: string, color: string) => {
      setFiles((prev) => prev.map((f) => (f.summary.path === path ? { ...f, color } : f)));
      up({ colors: { ...prefsRef.current.colors, [path]: color }, colorMode: "file" });
    },
    [up],
  );

  const setFilters = useCallback((filters: Filters) => up({ filters }), [up]);

  /** Kaydın tür/etiket/notunu kaydeder; tür değişince özeti günceller. */
  const updateMeta = useCallback(
    async (path: string, m: FileMeta) => {
      setMetaState((prev) => ({ ...prev, [path]: m }));
      try {
        const res = await saveMeta(path, m);
        if (res?.status === "ok") {
          setFiles((prev) => prev.map((f) => (f.summary.path === path ? { ...f, summary: res.file } : f)));
        } else if (res?.status === "error") fail(res.message, path);
      } catch (e) {
        fail(String(e), path);
      }
    },
    [fail],
  );

  const tagMany = useCallback(
    async (tag: string) => {
      setDialog(null);
      const paths = [...multi];
      for (const p of paths) {
        const m = meta[p] ?? EMPTY_META;
        if (!m.tags.includes(tag)) await updateMeta(p, { ...m, tags: [...m.tags, tag] });
      }
      say(`${fmtNumber(paths.length)} kayda “${tag}” etiketi eklendi.`);
    },
    [multi, meta, updateMeta, say],
  );

  const startCompare = useCallback(() => {
    const pair = [...multi];
    if (pair.length !== 2) return;
    // Eski kayıt A, yeni kayıt B.
    const t = (p: string) => filesRef.current.find((f) => f.summary.path === p)?.summary.stats.startTime ?? 0;
    pair.sort((a, b) => t(a) - t(b));
    setCompare([pair[0], pair[1]]);
    setSelected(null);
    mapRef.current?.fitFiles(filesRef.current.filter((f) => pair.includes(f.summary.path)));
  }, [multi]);

  const zoomRange = useCallback(() => {
    if (!detail || !range) return;
    const pts: [number, number][] = [];
    for (let i = range[0]; i <= range[1]; i++) pts.push([detail.lon[i], detail.lat[i]]);
    mapRef.current?.fitPoints(pts);
  }, [detail, range]);

  const metricLegend = useMemo(() => {
    if (!detail || prefs.trackColorBy === "none") return null;
    const d = metricDomain(detail[prefs.trackColorBy] as (number | null)[]);
    return d ? { metric: METRICS[prefs.trackColorBy], domain: d } : null;
  }, [detail, prefs.trackColorBy]);

  const dateLegend = useMemo(() => {
    if (prefs.colorMode !== "date") return null;
    const ts = files.map((f) => f.summary.stats.startTime).filter((t): t is number => t != null);
    if (ts.length === 0) return null;
    return [Math.min(...ts), Math.max(...ts)] as const;
  }, [files, prefs.colorMode]);

  const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
  const gradient = `linear-gradient(to right, ${ramp.join(", ")})`;

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
          onGroupBy={(groupBy) => up({ groupBy })}
          onToggleGroup={(key) =>
            up({
              collapsed: collapsed.has(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key],
            })
          }
          onRowClick={onRowClick}
          onZoom={selectAndZoom}
          onToggle={toggle}
          onToggleAll={(v) => setVisible(shown.map((f) => f.summary.path), v)}
          onRemove={removePaths}
          onOpenFiles={pickFiles}
          onOpenFolder={pickFolder}
          onCloseAll={closeAll}
          onSettings={() => setDialog("settings")}
          onSummary={() => setDialog("summary")}
          onMerge={openMerge}
          onExportCsv={exportCsv}
          onSetVisible={setVisible}
          onClearMulti={() => setMulti(new Set())}
          meta={meta}
          allTags={allTags}
          routeLabel={(() => {
            const r = routeInfo.routes.find((x) => x.id === prefs.filters.route);
            const f = r && files.find((x) => x.summary.path === r.paths[0]);
            return f ? (placeLabel(f.summary) ?? f.summary.name ?? f.summary.fileName) : null;
          })()}
          areaMode={areaMode}
          onAreaMode={setAreaMode}
          onCompare={startCompare}
          onTagMany={() => setDialog("tag")}
        />
      )}
      <main className="main">
        <div className="map-wrap">
          <MapView
            ref={mapRef}
            files={onMap}
            selected={selected}
            detail={detail}
            hoverIdx={hoverIdx}
            onHoverIdx={setHoverIdx}
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
              setSelected(p);
            }}
            areaMode={areaMode}
            area={prefs.filters.area}
            onArea={(area) => {
              setAreaMode(false);
              up({ filters: { ...prefsRef.current.filters, area } });
            }}
            stopsLayer={prefs.stopsLayer}
            highlight={compare}
            cursors={cursors}
          />
          <div className="map-toolbar">
            <button
              className="icon-btn"
              onClick={() => up({ sidebarOpen: !prefs.sidebarOpen })}
              title={prefs.sidebarOpen ? "Kenar çubuğunu gizle (Ctrl/⌘+B)" : "Kenar çubuğunu göster (Ctrl/⌘+B)"}
            >
              {prefs.sidebarOpen ? "⟨" : "☰"}
            </button>
            <div className="segmented">
              {BASE_LAYERS.map((l) => (
                <button key={l.id} className={l.id === baseLayer ? "active" : ""} onClick={() => setBaseLayer(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
            {files.length > 0 && (
              <>
                <div className="segmented">
                  <button className={!prefs.heatmap ? "active" : ""} onClick={() => up({ heatmap: false })}>
                    İzler
                  </button>
                  <button
                    className={prefs.heatmap ? "active" : ""}
                    onClick={() => up({ heatmap: true })}
                    title="En çok geçilen yerler (Ctrl/⌘+H)"
                  >
                    Isı haritası
                  </button>
                </div>
                <label className="map-select" title="İz renkleri">
                  <select
                    value={prefs.colorMode}
                    onChange={(e) => up({ colorMode: e.target.value as Prefs["colorMode"] })}
                    disabled={prefs.heatmap}
                  >
                    <option value="file">Renk: dosyaya göre</option>
                    <option value="date">Renk: tarihe göre</option>
                  </select>
                </label>
                <button
                  className={`btn small${prefs.stopsLayer ? " primary" : ""}`}
                  onClick={() => up({ stopsLayer: !prefs.stopsLayer })}
                  title="Tüm kayıtlarda en çok durulan yerler"
                >
                  Duraklar
                </button>
                {settings && (
                  <label
                    className="check map-check"
                    title={
                      settings.stats.cleanSpikes
                        ? `Bir anlığına uzağa fırlayıp geri dönen GPS noktaları haritadan ve hesaplardan çıkarılıyor (${fmtNumber(
                            files.reduce((n, f) => n + f.summary.removedPoints, 0),
                          )} nokta). Orijinal dosyalar değişmez.`
                        : "GPS sıçramaları temizlenmiyor; kayıtlar olduğu gibi gösteriliyor."
                    }
                  >
                    <input
                      type="checkbox"
                      checked={settings.stats.cleanSpikes}
                      onChange={(e) =>
                        applySettings({ ...settings, stats: { ...settings.stats, cleanSpikes: e.target.checked } })
                      }
                    />
                    Sıçramaları temizle
                  </label>
                )}
                <button className="btn small" onClick={fitAll} title="Tümünü göster (Ctrl/⌘+0)">
                  Tümünü göster
                </button>
                <button className="btn small" onClick={exportPng} title="Harita görüntüsünü kaydet (Ctrl/⌘+Shift+E)">
                  PNG
                </button>
              </>
            )}
          </div>

          <div className="legends">
            {prefs.heatmap && (
              <div className="legend">
                <span className="legend-title">Geçiş yoğunluğu</span>
                <div className="legend-bar" style={{ background: gradient }} />
                <div className="legend-ends">
                  <span>az</span>
                  <span>çok</span>
                </div>
              </div>
            )}
            {!prefs.heatmap && dateLegend && (
              <div className="legend">
                <span className="legend-title">Kayıt tarihi</span>
                <div className="legend-bar" style={{ background: gradient }} />
                <div className="legend-ends">
                  <span>{fmtDate(dateLegend[0])}</span>
                  <span>{fmtDate(dateLegend[1])}</span>
                </div>
              </div>
            )}
            {metricLegend && (
              <div className="legend">
                <span className="legend-title">
                  Seçili iz: {metricLegend.metric.label} ({metricLegend.metric.unit})
                </span>
                <div className="legend-bar" style={{ background: gradient }} />
                <div className="legend-ends">
                  <span>{fmtUnit(metricLegend.domain[0], "", metricLegend.metric.digits)}</span>
                  <span>{fmtUnit(metricLegend.domain[1], "", metricLegend.metric.digits)}</span>
                </div>
              </div>
            )}
          </div>

          <UpdateNotice />
          {(duplicates.length > 0 || errors.length > 0 || info || undo || watchOffer) && (
            <div className="toasts">
              {undo && (
                <div className="toast info">
                  <div className="toast-head">
                    <strong>{fmtNumber(undo.count)} kayıt kaldırıldı</strong>
                    <button className="btn small primary" onClick={doUndo}>
                      Geri al
                    </button>
                  </div>
                </div>
              )}
              {watchOffer && (
                <div className="toast info">
                  <div className="toast-head">
                    <strong>Bu klasör izlensin mi?</strong>
                    <button className="icon-btn" onClick={() => setWatchOffer(null)} title="Hayır">
                      ×
                    </button>
                  </div>
                  <div>Yeni eklenen GPX dosyaları kütüphaneye kendiliğinden eklenir.</div>
                  <div className="update-actions">
                    <button
                      className="btn small primary"
                      onClick={() => {
                        const s = settingsRef.current;
                        if (s) applySettings({ ...s, watchedFolders: [...s.watchedFolders, ...watchOffer] });
                        setWatchOffer(null);
                      }}
                    >
                      İzle
                    </button>
                    <button className="btn small" onClick={() => setWatchOffer(null)}>
                      Hayır
                    </button>
                  </div>
                </div>
              )}
              {info && (
                <div className="toast info">
                  <div className="toast-head">
                    <span>{info}</span>
                    <button className="icon-btn" onClick={() => setInfo(null)} title="Kapat">
                      ×
                    </button>
                  </div>
                </div>
              )}
              {duplicates.length > 0 && (
                <div className="toast info">
                  <div className="toast-head">
                    <strong>{duplicates.length} dosya zaten kütüphanede, eklenmedi</strong>
                    <button className="icon-btn" onClick={() => setDuplicates([])} title="Kapat">
                      ×
                    </button>
                  </div>
                  <ul>
                    {duplicates.slice(0, 5).map((d, i) => (
                      <li key={i}>
                        <span className="path">{baseName(d.path)}</span> → {d.existing}
                      </li>
                    ))}
                    {duplicates.length > 5 && <li>… ve {duplicates.length - 5} dosya daha</li>}
                  </ul>
                </div>
              )}
              {errors.length > 0 && (
                <div className="toast error">
                  <div className="toast-head">
                    <strong>{errors.length === 1 && !errors[0].path ? "Bir sorun oluştu" : `${errors.length} sorun`}</strong>
                    <button className="icon-btn" onClick={() => setErrors([])} title="Kapat">
                      ×
                    </button>
                  </div>
                  <ul>
                    {errors.slice(0, 5).map((e, i) => (
                      <li key={i}>
                        {e.path && <span className="path">{baseName(e.path)}</span>} {e.message}
                      </li>
                    ))}
                    {errors.length > 5 && <li>… ve {errors.length - 5} tane daha</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
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
          <DetailPanel
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
            hoverIdx={hoverIdx}
            onHover={setHoverIdx}
            range={range}
            onRange={setRange}
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
            onClose={() => setSelected(null)}
            onZoom={() => zoomTo(selectedEntry.summary.path)}
            onExportGpx={exportSelectedGpx}
            meta={meta[selectedEntry.summary.path] ?? EMPTY_META}
            allTags={allTags}
            onMeta={(m) => updateMeta(selectedEntry.summary.path, m)}
            routeCount={routeInfo.byPath.get(selectedEntry.summary.path)?.paths.length ?? 0}
            onOpenRoute={() => setRouteModal(routeInfo.byPath.get(selectedEntry.summary.path) ?? null)}
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
          onSave={(s, tzMode: TzMode) => {
            setDialog(null);
            up({ tzMode });
            applySettings(s);
          }}
        />
      )}
      {dialog === "summary" && (
        <SummaryPanel
          files={shown}
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
          onPeriod={(from, to) => {
            setDialog(null);
            up({ filters: { ...prefs.filters, from, to } });
          }}
          onOpen={(p) => {
            setDialog(null);
            selectAndZoom(p);
          }}
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
          files={new Map(colored.map((f) => [f.summary.path, f]))}
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
          <div>GPX, FIT, TCX, KML dosyalarını ya da klasörleri bırakın</div>
        </div>
      )}
    </div>
  );
}
