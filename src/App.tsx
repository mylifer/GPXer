import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  expandPaths,
  libraryFiles,
  loadDetail,
  loadFiles,
  removeFiles,
  takePendingPaths,
  type Detail,
} from "./api";
import { BASE_LAYERS, MapView, type BaseLayer, type MapHandle } from "./components/MapView";
import { Sidebar, type Filters } from "./components/Sidebar";
import { DetailPanel } from "./components/DetailPanel";
import { UpdateNotice } from "./components/UpdateNotice";
import { PALETTE, type FileEntry } from "./types";

/** Tek seferde Rust tarafına gönderilen dosya sayısı; ilerleme çubuğunun
 * akıcı güncellenmesi için küçük tutulur. */
const CHUNK = 24;

interface LoadError {
  path: string;
  message: string;
}

interface Duplicate {
  path: string;
  /** Kütüphanedeki aynı içerikli dosyanın adı. */
  existing: string;
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* önemli değil */
  }
}

function dayStart(s: string) {
  return s ? new Date(`${s}T00:00:00`).getTime() : null;
}

export default function App() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<LoadError[]>([]);
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [showSpeed, setShowSpeed] = useState(() => readPref<string>("showSpeed", "0") === "1");
  const [baseLayer, setBaseLayer] = useState<BaseLayer>(() => readPref<BaseLayer>("baseLayer", "osm"));
  const [filters, setFilters] = useState<Filters>({ query: "", from: "", to: "", sort: "date-desc" });

  const mapRef = useRef<MapHandle>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const colorCounter = useRef(0);
  const loadQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => writePref("baseLayer", baseLayer), [baseLayer]);
  useEffect(() => writePref("showSpeed", showSpeed ? "1" : "0"), [showSpeed]);

  const shown = useMemo(() => {
    const q = filters.query.trim().toLocaleLowerCase("tr-TR");
    const from = dayStart(filters.from);
    const toStart = dayStart(filters.to);
    const to = toStart == null ? null : toStart + 86_400_000;
    const list = files.filter((f) => {
      const s = f.summary;
      if (q && !`${s.name ?? ""} ${s.fileName}`.toLocaleLowerCase("tr-TR").includes(q)) return false;
      const t = s.stats.startTime;
      if (from != null && (t == null || t < from)) return false;
      if (to != null && (t == null || t >= to)) return false;
      return true;
    });
    const byDate = (a: FileEntry, b: FileEntry) =>
      (a.summary.stats.startTime ?? 0) - (b.summary.stats.startTime ?? 0);
    const byName = (a: FileEntry, b: FileEntry) =>
      (a.summary.name || a.summary.fileName).localeCompare(b.summary.name || b.summary.fileName, "tr-TR", {
        numeric: true,
      });
    switch (filters.sort) {
      case "date-desc":
        return list.sort((a, b) => byDate(b, a));
      case "date-asc":
        return list.sort(byDate);
      case "name":
        return list.sort(byName);
      case "distance":
        return list.sort((a, b) => b.summary.stats.distanceM - a.summary.stats.distanceM);
    }
  }, [files, filters]);

  const onMap = useMemo(() => shown.filter((f) => f.visible), [shown]);
  const selectedEntry = useMemo(
    () => (selected ? files.find((f) => f.summary.path === selected) ?? null : null),
    [files, selected],
  );

  // Seçilen dosyanın grafik verisini yükle.
  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setHoverIdx(null);
    if (!selected) return;
    let cancelled = false;
    loadDetail(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setDetailError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const openPaths = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    // Birden fazla açma isteği üst üste gelirse sırayla işlenir.
    loadQueue.current = loadQueue.current.then(async () => {
      const expanded = await expandPaths(paths);
      const known = new Set(filesRef.current.map((f) => f.summary.path));
      const todo = expanded.filter((p) => !known.has(p));
      if (todo.length === 0) {
        // Zaten açık tek bir dosya tekrar açıldıysa onu seç.
        if (expanded.length === 1) setSelected(expanded[0]);
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
            batch.push({ summary: r.file, color: PALETTE[colorCounter.current++ % PALETTE.length], visible: true });
          } else if (r.status === "duplicate") {
            newDuplicates.push({ path: r.path, existing: existingOf(r.existing) });
            // Tek bir dosya açıldıysa ve zaten kütüphanedeyse onu seç.
            if (todo.length === 1) setSelected(r.existing);
          } else {
            newErrors.push({ path: r.path, message: r.message });
          }
        }
        added.push(...batch);
        setFiles((prev) => [...prev, ...batch]);
        setLoading({ done: Math.min(todo.length, i + CHUNK), total: todo.length });
      }
      setLoading(null);
      if (newErrors.length) setErrors((prev) => [...prev, ...newErrors]);
      if (newDuplicates.length) setDuplicates((prev) => [...prev, ...newDuplicates]);
      if (added.length === 1) setSelected(added[0].summary.path);
      if (added.length > 0) {
        // İlk yüklemede hepsini, sonradan eklemede yalnızca yenileri göster.
        requestAnimationFrame(() => mapRef.current?.fitFiles(wasEmpty ? filesRef.current : added));
      }
    }).catch((e) => {
      setLoading(null);
      setErrors((prev) => [...prev, { path: "", message: String(e) }]);
    });
  }, []);

  const pickFiles = useCallback(async () => {
    const res = await open({ multiple: true, filters: [{ name: "GPX", extensions: ["gpx", "GPX"] }] });
    if (res) openPaths(Array.isArray(res) ? res : [res]);
  }, [openPaths]);

  const pickFolder = useCallback(async () => {
    const res = await open({ directory: true, multiple: true });
    if (res) openPaths(Array.isArray(res) ? res : [res]);
  }, [openPaths]);

  const closeAll = useCallback(async () => {
    const all = filesRef.current.map((f) => f.summary.path);
    if (all.length === 0) return;
    const ok = await ask(`Kütüphanedeki ${all.length} dosyanın tamamı silinsin mi? Orijinal dosyalarınız etkilenmez.`, {
      title: "Kütüphaneyi temizle",
      kind: "warning",
      okLabel: "Temizle",
      cancelLabel: "Vazgeç",
    });
    if (!ok) return;
    try {
      await removeFiles(all);
    } catch (e) {
      setErrors((prev) => [...prev, { path: "", message: String(e) }]);
    }
    setFiles([]);
    setSelected(null);
    setErrors([]);
    setDuplicates([]);
    colorCounter.current = 0;
  }, []);

  const fitAll = useCallback(() => {
    mapRef.current?.fitFiles(filesRef.current.filter((f) => f.visible));
  }, []);

  // Sürükle-bırak, menü ve işletim sisteminden gelen dosyalar.
  useEffect(() => {
    const unlisten: Promise<() => void>[] = [];
    const drainPending = () => takePendingPaths().then(openPaths);

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
    unlisten.push(
      listen<string>("menu", (e) => {
        switch (e.payload) {
          case "open_files":
            return pickFiles();
          case "open_folder":
            return pickFolder();
          case "close_all":
            return closeAll();
          case "fit_all":
            return fitAll();
          case "toggle_sidebar":
            return setSidebarOpen((v) => !v);
        }
      }),
    );
    // Önce kütüphane, ardından işletim sisteminden gelen dosyalar yüklenir.
    libraryFiles()
      .then(openPaths)
      .finally(drainPending);
    return () => unlisten.forEach((p) => p.then((fn) => fn()));
  }, [openPaths, pickFiles, pickFolder, closeAll, fitAll]);

  // Klavye: Esc seçimi kaldırır, ↑/↓ listede gezinir.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") setSelected(null);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = shown.findIndex((f) => f.summary.path === selected);
        const next = e.key === "ArrowDown" ? idx + 1 : idx < 0 ? shown.length - 1 : idx - 1;
        const target = shown[Math.max(0, Math.min(shown.length - 1, next))];
        if (target) {
          setSelected(target.summary.path);
          document
            .querySelector(`.file-row[data-path="${CSS.escape(target.summary.path)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown, selected]);

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

  const toggle = useCallback((path: string) => {
    setFiles((prev) => prev.map((f) => (f.summary.path === path ? { ...f, visible: !f.visible } : f)));
  }, []);

  const toggleAll = useCallback(
    (visible: boolean) => {
      const ids = new Set(shown.map((f) => f.summary.path));
      setFiles((prev) => prev.map((f) => (ids.has(f.summary.path) ? { ...f, visible } : f)));
    },
    [shown],
  );

  const remove = useCallback((path: string) => {
    removeFiles([path]).catch((e) => setErrors((prev) => [...prev, { path, message: String(e) }]));
    setFiles((prev) => prev.filter((f) => f.summary.path !== path));
    setSelected((s) => (s === path ? null : s));
  }, []);

  const cursor = useMemo<[number, number] | null>(() => {
    if (!detail || hoverIdx == null || hoverIdx >= detail.lat.length) return null;
    return [detail.lon[hoverIdx], detail.lat[hoverIdx]];
  }, [detail, hoverIdx]);

  return (
    <div className={`app${sidebarOpen ? "" : " sidebar-closed"}`}>
      {sidebarOpen && (
        <Sidebar
          files={files}
          shown={shown}
          filters={filters}
          selected={selected}
          loading={loading}
          onFilters={setFilters}
          onSelect={setSelected}
          onZoom={selectAndZoom}
          onToggle={toggle}
          onToggleAll={toggleAll}
          onRemove={remove}
          onOpenFiles={pickFiles}
          onOpenFolder={pickFolder}
          onCloseAll={closeAll}
        />
      )}
      <main className="main">
        <div className="map-wrap">
          <MapView
            ref={mapRef}
            files={onMap}
            selected={selected}
            cursor={cursor}
            baseLayer={baseLayer}
            onSelect={setSelected}
          />
          <div className="map-toolbar">
            <button
              className="icon-btn"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "Kenar çubuğunu gizle" : "Kenar çubuğunu göster"}
            >
              {sidebarOpen ? "⟨" : "☰"}
            </button>
            <div className="segmented">
              {BASE_LAYERS.map((l) => (
                <button key={l.id} className={l.id === baseLayer ? "active" : ""} onClick={() => setBaseLayer(l.id)}>
                  {l.label}
                </button>
              ))}
            </div>
            {files.length > 0 && (
              <button className="btn small" onClick={fitAll} title="Tümünü göster (Ctrl/Cmd+0)">
                Tümünü göster
              </button>
            )}
          </div>
          <UpdateNotice />
          {(duplicates.length > 0 || errors.length > 0) && (
            <div className="toasts">
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
                    <strong>{errors.length} dosya açılamadı</strong>
                    <button className="icon-btn" onClick={() => setErrors([])} title="Kapat">
                      ×
                    </button>
                  </div>
                  <ul>
                    {errors.slice(0, 5).map((e, i) => (
                      <li key={i}>
                        <span className="path">{e.path.split(/[\\/]/).pop()}</span> {e.message}
                      </li>
                    ))}
                    {errors.length > 5 && <li>… ve {errors.length - 5} dosya daha</li>}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
        {selectedEntry && (
          <DetailPanel
            entry={selectedEntry}
            detail={detail}
            detailError={detailError}
            showSpeed={showSpeed}
            onShowSpeed={setShowSpeed}
            onHover={setHoverIdx}
            onClose={() => setSelected(null)}
            onZoom={() => zoomTo(selectedEntry.summary.path)}
          />
        )}
      </main>
      {dragging && (
        <div className="drop-overlay">
          <div>GPX dosyalarını ya da klasörleri bırakın</div>
        </div>
      )}
    </div>
  );
}
