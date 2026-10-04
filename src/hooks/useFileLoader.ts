import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  expandPaths,
  flushCache,
  libraryFiles,
  loadFiles,
  removeFiles,
  restoreFiles,
  setSettings as saveSettings,
  type LoadResult,
  type Settings,
  type TrashItem,
} from "../api";
import type { MapHandle } from "../components/MapView";
import { defaultColor, type FileEntry } from "../types";
import { savePrefs, type Prefs } from "../prefs";
import { fmtNumber } from "../format";
import type { Route } from "../routes";
import { baseName } from "../lib/paths";
import type { Duplicate, LoadError } from "./useNotices";

/** Tek seferde Rust tarafına gönderilen dosya sayısı; ilerleme çubuğunun
 * akıcı güncellenmesi için küçük tutulur. */
const CHUNK = 24;
const UNDO_MS = 12_000;


export interface OpenOptions {
  /** Kopya bildirimleri gösterilmesin (kütüphane, izlenen klasörler). */
  quiet?: boolean;
  /** Yükleme bitince haritayı yeni kayıtlara yakınlaştırma. */
  noFit?: boolean;
  /** Tek kayıt eklendiğinde onu seçme. */
  noSelect?: boolean;
  /** "Yeni kayıt eklendi" bildirimi gösterilmesin. */
  silent?: boolean;
  /** Kullanıcı dosyaları kendisi açtı (kütüphaneden çıkarılmışlar da eklenir). */
  explicit?: boolean;
}

/** Yeniden yükleme sürerken kullanıcı kendisi bir kayıt seçti (ya da seçimi
 * kaldırdı): yükleme bitince eski seçim geri getirilmez. */
const KEEP_SELECTION = Symbol("keep");

export const OPEN_EXTS = ["gpx", "GPX", "fit", "FIT", "tcx", "TCX", "kml", "KML", "json", "JSON"];

interface Deps {
  prefsRef: RefObject<Prefs>;
  persistedSel: RefObject<string | null>;
  up(patch: Partial<Prefs>): void;
  say(msg: string): void;
  fail(message: string, path?: string): void;
  setErrors: Dispatch<SetStateAction<LoadError[]>>;
  setDuplicates: Dispatch<SetStateAction<Duplicate[]>>;
  setEmpties: Dispatch<SetStateAction<string[]>>;
  mapRef: RefObject<MapHandle | null>;
  setCompare: Dispatch<SetStateAction<[string, string] | null>>;
  setMulti: Dispatch<SetStateAction<Set<string>>>;
  /** Güncel güzergâh bilgisi (kaldırılan kayda bağlı güzergâh filtresi için). */
  routeInfoRef: RefObject<{ byPath: Map<string, Route> } | null>;
}

/**
 * Kütüphane: dosya listesi, seçim, yükleme kuyruğu, ayarlarla yeniden yükleme,
 * kaldırma ve geri alma. Yükleme yarışlarına karşı düzeltmeler (nesil sayacı,
 * seçimin geri getirilmesi, biriken liste) burada bir arada durur.
 */
export function useFileLoader({
  prefsRef,
  persistedSel,
  up,
  say,
  fail,
  setErrors,
  setDuplicates,
  setEmpties,
  mapRef,
  setCompare,
  setMulti,
  routeInfoRef,
}: Deps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(prefsRef.current.selected);
  const [loading, setLoading] = useState<{ done: number; total: number } | null>(null);
  const [undo, setUndo] = useState<{ items: TrashItem[]; count: number } | null>(null);
  const [watchOffer, setWatchOffer] = useState<string[] | null>(null);
  const [settings, setSettingsState] = useState<Settings | null>(null);

  const filesRef = useRef(files);
  filesRef.current = files;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const loadQueue = useRef<Promise<void>>(Promise.resolve());
  /** Yeniden yükleme (ayar değişikliği) sayacı: eski ayarlarla süren yüklemeler
   * her beklemeden sonra bunu denetler ve sonuçlarını bırakır. */
  const loadGen = useRef(0);
  /** Yeniden yükleme bitince geri seçilecek kayıt (undefined: bekleyen yok;
   * KEEP_SELECTION: kullanıcı bu arada kendisi seçti, dokunulmaz). */
  const restoreSel = useRef<string | null | undefined | typeof KEEP_SELECTION>(undefined);
  /** Yeniden yükleme sürerken yeni özetler burada birikir; liste ve harita
   * eski kayıtları gösterir, yükleme bitince bir kerede değiştirilir. */
  const reloadBuf = useRef<FileEntry[] | null>(null);
  const [reloading, setReloading] = useState(false);
  const initialLoad = useRef(true);

  useEffect(() => {
    // Yeniden yükleme sürerken geçici boş seçim kaydedilmez; kayıtlı seçim geri getirilene kadar korunur.
    const r = restoreSel.current;
    if (r !== undefined && r !== KEEP_SELECTION) return;
    persistedSel.current = selected;
    savePrefs({ ...prefsRef.current, selected });
  }, [selected]);

  /** Kullanıcının yaptığı seçim: süren bir yeniden yükleme bunu ezmesin. */
  const pick = useCallback((path: string | null) => {
    if (restoreSel.current !== undefined) restoreSel.current = KEEP_SELECTION;
    setSelected(path);
  }, []);

  /** Dosya listesini değiştirir; yeniden yükleme sürüyorsa biriken yeni listeye de uygular. */
  const patchFiles = useCallback((fn: (list: FileEntry[]) => FileEntry[]) => {
    setFiles(fn);
    if (reloadBuf.current) reloadBuf.current = fn(reloadBuf.current);
  }, []);

  const entryFor = useCallback(
    (file: FileEntry["summary"]): FileEntry => ({
      summary: file,
      color: prefsRef.current.colors[file.path] ?? defaultColor(file.path),
      visible: !prefsRef.current.hidden.includes(file.path),
    }),
    [],
  );

  /** İşi yükleme kuyruğuna ekler; üst üste gelen istekler sırayla işlenir. */
  const enqueue = useCallback(
    (job: () => Promise<void>) => {
      loadQueue.current = loadQueue.current.then(job).catch((e) => {
        setLoading(null);
        fail(String(e));
      });
      return loadQueue.current;
    },
    [fail],
  );

  /**
   * Yolları yükler (kuyruğun içinden çağrılır). Bu sırada ayarlar değişip
   * kütüphane yeniden yüklenmeye başlarsa (loadGen) eski ayarlarla hesaplanan
   * sonuçlar bırakılır; `requeue` verilmişse yollar yeniden kuyruğa alınır.
   * Eklenen kayıtları döner.
   */
  const loadJob = useCallback(
    async (paths: string[], opts: OpenOptions, requeue?: () => void): Promise<FileEntry[]> => {
      const gen = loadGen.current;
      // Her eklemede tüm kütüphanenin harita katmanları ve süzgeçleri yeniden
      // kurulur; her parçada eklemek büyük kütüphanede açılışı karesel
      // yavaşlatıyordu (3000 kayıtta 69 sn). Eklenenler, listeyi en az ikiye
      // katlayacak kadar birikince (ya da 2 sn geçince) işlenir: ilk kayıtlar
      // hemen görünür, toplam iş n·log n olur.
      let unsent: FileEntry[] = [];
      let shown = filesRef.current.length;
      let sentAt = performance.now();
      const send = () => {
        sentAt = performance.now();
        if (!unsent.length) return;
        const batch = unsent;
        unsent = [];
        shown += batch.length;
        setFiles((prev) => [...prev, ...batch]);
      };
      const stale = () => {
        if (gen === loadGen.current) return false;
        send();
        setLoading(null);
        requeue?.();
        return true;
      };
      const expanded = await expandPaths(paths);
      if (stale()) return [];
      /** Yeniden yüklemede yeni liste ayrı birikir; aksi halde doğrudan listeye eklenir. */
      const current = () => reloadBuf.current ?? filesRef.current;
      const known = new Set(current().map((f) => f.summary.path));
      const todo = expanded.filter((p) => !known.has(p));
      if (todo.length === 0) {
        // Zaten açık tek bir dosya tekrar açıldıysa onu seç.
        if (expanded.length === 1 && !opts.noSelect) pick(expanded[0]);
        return [];
      }
      const wasEmpty = current().length === 0;
      const added: FileEntry[] = [];
      const newErrors: LoadError[] = [];
      const newDuplicates: Duplicate[] = [];
      const newEmpties: string[] = [];
      let selectExisting: string | null = null;
      const label = (f: FileEntry) => f.summary.name || f.summary.fileName;
      const names = new Map(current().map((f) => [f.summary.path, label(f)]));
      const existingOf = (path: string) => names.get(path) ?? baseName(path);
      setLoading({ done: 0, total: todo.length });
      for (let i = 0; i < todo.length; i += CHUNK) {
        const results = await loadFiles(todo.slice(i, i + CHUNK), !!opts.explicit);
        // Eski ayarlarla hesaplandı: listeye eklenmez.
        if (stale()) return [];
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
            if (todo.length === 1 && !opts.noSelect) selectExisting = r.existing;
          } else if (r.status === "empty") {
            newEmpties.push(r.path);
          } else {
            newErrors.push({ path: r.path, message: r.message });
          }
        }
        added.push(...batch);
        for (const f of batch) names.set(f.summary.path, label(f));
        if (reloadBuf.current) {
          reloadBuf.current = [...reloadBuf.current, ...batch];
        } else {
          filesRef.current = [...filesRef.current, ...batch];
          unsent.push(...batch);
          if (unsent.length >= Math.max(CHUNK, shown) || performance.now() - sentAt >= 2000) send();
        }
        setLoading({ done: Math.min(todo.length, i + CHUNK), total: todo.length });
      }
      send();
      setLoading(null);
      flushCache().catch(() => {});
      if (selectExisting) pick(selectExisting);
      if (newErrors.length) setErrors((prev) => [...prev, ...newErrors]);
      if (newDuplicates.length && !opts.quiet) setDuplicates((prev) => [...prev, ...newDuplicates]);
      if (newEmpties.length && !opts.quiet) setEmpties((prev) => [...prev, ...newEmpties]);
      if (added.length === 1 && !opts.noSelect) pick(added[0].summary.path);
      if (added.length > 0 && !opts.noFit) {
        // İlk yüklemede hepsini, sonradan eklemede yalnızca yenileri göster.
        requestAnimationFrame(() => mapRef.current?.fitFiles(wasEmpty ? filesRef.current : added));
      }
      if (opts.quiet && !opts.silent && added.length > 0 && !initialLoad.current) {
        say(`${fmtNumber(added.length)} yeni kayıt kütüphaneye eklendi.`);
      }
      return added;
    },
    [entryFor, say, pick],
  );

  const openPaths = useCallback(
    function openPaths(paths: string[], opts: OpenOptions = {}): Promise<void> {
      if (paths.length === 0) return loadQueue.current;
      return enqueue(async () => {
        // Yeniden yüklemeyle kesilirse, o bittikten sonra baştan denenir
        // (zaten yüklenmiş olanlar atlanır).
        await loadJob(paths, opts, () => void openPaths(paths, opts));
      });
    },
    [enqueue, loadJob],
  );

  /** Kütüphaneyi (ve izlenen klasörleri) güncel ayarlarla baştan yükler. */
  const reloadAll = useCallback(() => {
    const gen = ++loadGen.current;
    // Üst üste yeniden yüklemelerde ilk seçim korunur; kullanıcı bu arada
    // kendisi seçtiyse yeni yükleme bittiğinde onun seçimi geri gelir.
    if (restoreSel.current === undefined || restoreSel.current === KEEP_SELECTION) {
      restoreSel.current = selectedRef.current;
    }
    setSelected(null);
    setCompare(null);
    setReloading(true);
    return enqueue(async () => {
      if (gen !== loadGen.current) return;
      try {
        // Eski liste yükleme bitene kadar görünür kalır.
        reloadBuf.current = [];
        const lib = await libraryFiles();
        if (gen !== loadGen.current) return;
        const quiet: OpenOptions = { quiet: true, noFit: true, noSelect: true, silent: true };
        await loadJob(lib, quiet);
        const folders = settingsRef.current?.watchedFolders ?? [];
        if (gen !== loadGen.current) return;
        if (folders.length) await loadJob(folders, quiet);
      } finally {
        // Daha yeni bir yeniden yükleme başladıysa seçimi o geri getirir.
        if (gen === loadGen.current) {
          const next = reloadBuf.current ?? filesRef.current;
          reloadBuf.current = null;
          filesRef.current = next;
          setFiles(next);
          setReloading(false);
          const sel = restoreSel.current;
          restoreSel.current = undefined;
          // Kullanıcı bu arada kendisi seçtiyse onun seçimine dokunulmaz.
          if (sel !== KEEP_SELECTION) setSelected(sel && next.some((f) => f.summary.path === sel) ? sel : null);
          else setSelected((cur) => (cur && next.some((f) => f.summary.path === cur) ? cur : null));
        }
      }
    });
  }, [enqueue, loadJob]);

  /** Yeni oluşturulan kayıtları (kırpma, bölme, birleştirme) listeye ekler. */
  const addResults = useCallback(
    (results: LoadResult[]) => {
      const added: FileEntry[] = [];
      for (const r of results) {
        if (r.status === "ok") added.push(entryFor(r.file));
        else if (r.status === "error") fail(r.message, r.path);
        else if (r.status === "empty") say(`Kayıtta hiç nokta yok: ${baseName(r.path)}`);
        else say(`Bu kayıt zaten kütüphanede: ${baseName(r.existing)}`);
      }
      if (added.length) {
        patchFiles((prev) => [...prev, ...added]);
        flushCache().catch(() => {});
      }
      return added;
    },
    [entryFor, fail, say, patchFiles],
  );

  const pickFiles = useCallback(async () => {
    const res = await open({
      multiple: true,
      filters: [{ name: "İz dosyaları (GPX, FIT, TCX, KML, Google konum geçmişi JSON)", extensions: OPEN_EXTS }],
    });
    if (res) openPaths(Array.isArray(res) ? res : [res], { explicit: true });
  }, [openPaths]);

  const pickFolder = useCallback(async () => {
    const res = await open({ directory: true, multiple: true });
    if (!res) return;
    const folders = Array.isArray(res) ? res : [res];
    openPaths(folders, { explicit: true });
    const watched = new Set(settingsRef.current?.watchedFolders ?? []);
    const offer = folders.filter((f) => !watched.has(f));
    if (offer.length) setWatchOffer(offer);
  }, [openPaths]);

  const applySettings = useCallback(
    async (next: Settings) => {
      const prev = settingsRef.current;
      settingsRef.current = next;
      setSettingsState(next);
      try {
        const problems = await saveSettings(next);
        problems.forEach((m) => fail(m));
      } catch (e) {
        fail(String(e));
        settingsRef.current = prev;
        setSettingsState(prev);
        return;
      }
      const statsChanged =
        !prev ||
        prev.stats.movingSpeedMs !== next.stats.movingSpeedMs ||
        prev.stats.elevationThresholdM !== next.stats.elevationThresholdM ||
        prev.stats.cleanSpikes !== next.stats.cleanSpikes ||
        prev.stats.perType !== next.stats.perType ||
        prev.stats.collapseStays !== next.stats.collapseStays;
      if (statsChanged) {
        // İstatistikleri yeni eşiklerle yeniden hesapla (izlenen klasörler dahil).
        reloadAll();
        return;
      }
      const newFolders = next.watchedFolders.filter((f) => !prev?.watchedFolders.includes(f));
      if (newFolders.length) openPaths(newFolders, { quiet: true, noSelect: true });
    },
    [fail, openPaths, reloadAll],
  );

  const removePaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      const set = new Set(paths);
      let items: TrashItem[];
      try {
        items = await removeFiles(paths);
      } catch (e) {
        // Kaldırılamadı: liste olduğu gibi kalır.
        fail(String(e));
        return;
      }
      // Geri alma penceresi içindeki ardışık kaldırmalar birlikte geri alınır.
      setUndo((u) => (u ? { items: [...u.items, ...items], count: u.count + paths.length } : { items, count: paths.length }));
      // Güzergâh filtresi kaldırılan kayda bağlıysa güzergâhın kalan bir kaydına taşı.
      const fr = prefsRef.current.filters.route;
      if (fr && set.has(fr)) {
        const keep = routeInfoRef.current?.byPath.get(fr)?.paths.find((p) => !set.has(p)) ?? null;
        up({ filters: { ...prefsRef.current.filters, route: keep } });
      }
      filesRef.current = filesRef.current.filter((f) => !set.has(f.summary.path));
      // Yeniden yükleme sürerken silinenler yeni listeye de girmesin.
      if (reloadBuf.current) reloadBuf.current = reloadBuf.current.filter((f) => !set.has(f.summary.path));
      patchFiles((prev) => prev.filter((f) => !set.has(f.summary.path)));
      setSelected((s) => (s && set.has(s) ? null : s));
      setCompare((c) => (c && c.some((p) => set.has(p)) ? null : c));
      setMulti((m) => new Set([...m].filter((p) => !set.has(p))));
    },
    [fail, up, patchFiles],
  );

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  const doUndo = useCallback(async () => {
    if (!undo) return;
    setUndo(null);
    let restored: string[];
    try {
      restored = await restoreFiles(undo.items);
    } catch (e) {
      fail(String(e));
      return;
    }
    // Geri getirme kullanıcının isteği: kaldırılanlar listesinden de çıkarılsınlar.
    await openPaths(restored, { quiet: true, silent: true, noFit: true, noSelect: restored.length !== 1, explicit: true });
    // Bu arada yeniden içe aktarılanlar ikinci kez getirilmez.
    const skipped = undo.items.length - restored.length;
    say(
      `${fmtNumber(restored.length)} kayıt geri getirildi.` +
        (skipped > 0 ? ` ${fmtNumber(skipped)} kayıt zaten kütüphanede olduğu için atlandı.` : ""),
    );
  }, [undo, openPaths, say, fail]);

  const closeAll = useCallback(async () => {
    const all = filesRef.current.map((f) => f.summary.path);
    if (all.length === 0) return;
    const ok = await ask(
      `Kütüphanedeki ${all.length} kaydın tamamı kaldırılsın mı? Orijinal dosyalarınız etkilenmez; hemen ardından “Geri al” ile geri getirebilirsiniz.`,
      { title: "Kütüphaneyi boşalt", kind: "warning", okLabel: "Boşalt", cancelLabel: "Vazgeç" },
    );
    if (!ok) return;
    await removePaths(all);
    setErrors([]);
    setDuplicates([]);
    setEmpties([]);
  }, [removePaths]);

  return {
    files,
    filesRef,
    selected,
    setSelected,
    selectedRef,
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
  };
}
