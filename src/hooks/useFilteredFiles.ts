import { useCallback, useMemo, useRef, type RefObject } from "react";
import type { FileMeta, FileSummary, NamedPlace } from "../api";
import type { Group } from "../components/Sidebar";
import { findRoutes, type Route } from "../routes";
import { linesHitBox } from "../geo";
import { SEQ_DARK, SEQ_LIGHT, placeLabel, rampColor, type FileEntry } from "../types";
import type { Prefs } from "../prefs";
import { dayBuckets, rangeShare, touchesRange } from "../days";
import { dayKey, monthLabel, searchKey, tzOf } from "../format";
import { findOverlaps } from "../overlaps";
import { flightsOf, type Flight } from "../flights";

/**
 * Dosya listesinden türetilen veriler: renkler, güzergâhlar, çakışmalar,
 * filtreye uyanlar (shown), gruplar, ekrandaki satırlar, haritadakiler.
 */
export function useFilteredFiles({
  files,
  prefs,
  meta,
  places,
  dark,
  selected,
  routeInfoRef,
}: {
  files: FileEntry[];
  prefs: Prefs;
  meta: Record<string, FileMeta>;
  places: NamedPlace[];
  dark: boolean;
  selected: string | null;
  routeInfoRef: RefObject<{ routes: Route[]; byPath: Map<string, Route> } | null>;
}) {
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

  /** Özetlerin listesi; yalnızca özetler değişince yeni dizi (görünürlük, renk
   * gibi değişiklikler güzergâh hesabını tetiklemesin). */
  const summariesRef = useRef<FileSummary[]>([]);
  const summaries = useMemo(() => {
    const prev = summariesRef.current;
    if (prev.length === files.length && files.every((f, i) => f.summary === prev[i])) return prev;
    return (summariesRef.current = files.map((f) => f.summary));
  }, [files]);

  /** Tekrarlanan güzergâhlar (tüm kütüphane üzerinden). */
  const routeInfo = useMemo(() => findRoutes(summaries), [summaries]);
  routeInfoRef.current = routeInfo;
  /** Güzergâh filtresi: kayıtlı yolu içeren güzergâh (yoksa null). */
  const activeRoute = prefs.filters.route ? (routeInfo.byPath.get(prefs.filters.route) ?? null) : null;

  /** Zamanı çakışan kayıtlar (tüm kütüphane üzerinden). */
  const overlapInfo = useMemo(() => findOverlaps(summaries), [summaries]);

  const shown = useMemo(() => {
    const fl = prefs.filters;
    const q = searchKey(fl.query.trim());
    const dateOn = !!(fl.from || fl.to);
    const list = colored.filter((f) => {
      const s = f.summary;
      const m = meta[s.path];
      if (q) {
        const hay = `${s.name ?? ""} ${s.fileName} ${s.startPlace ?? ""} ${s.endPlace ?? ""} ${places.length ? (placeLabel(s) ?? "") : ""} ${m?.tags.join(" ") ?? ""} ${m?.note ?? ""}`;
        if (!searchKey(hay).includes(q)) return false;
      }
      if (fl.activity && s.activity !== fl.activity) return false;
      if (fl.tag && !m?.tags.includes(fl.tag)) return false;
      if (fl.route && (!activeRoute || routeInfo.byPath.get(s.path) !== activeRoute)) return false;
      if (fl.overlap && !overlapInfo.has(s.path)) return false;
      if (fl.area && !linesHitBox(s.lines, fl.area, s.stats.bbox)) return false;
      if (!dateOn) return true;
      if (s.stats.startTime == null) return fl.includeUndated;
      // Birden çok güne yayılan kayıt, günlerinden biri aralıktaysa uyar.
      return touchesRange(s, fl.from, fl.to);
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
  }, [colored, prefs.filters, meta, routeInfo, activeRoute, prefs.tzMode, overlapInfo, places]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const part = rangeShare(f.summary, prefs.filters.from, prefs.filters.to);
      g.distanceM += part.distanceM;
      g.movingMs += part.movingMs;
    }
    return [...map.values()];
  }, [shown, prefs.groupBy, prefs.tzMode, prefs.filters.from, prefs.filters.to]); // eslint-disable-line react-hooks/exhaustive-deps

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
      for (const d of dayBuckets(f.summary)) ys.add(Number(d.day.slice(0, 4)));
    }
    return [...ys].sort((a, b) => b - a);
  }, [files, prefs.tzMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMap = useMemo(() => shown.filter((f) => f.visible), [shown]);
  const dateWindow = useMemo(
    () => (prefs.filters.from || prefs.filters.to ? { from: prefs.filters.from, to: prefs.filters.to } : null),
    [prefs.filters.from, prefs.filters.to],
  );
  const onMapRef = useRef(onMap);
  onMapRef.current = onMap;

  /** Haritada uçuş yayları: gösterilen kayıtların (tarih filtresine düşen) uçuşları. */
  const mapFlights = useMemo(() => {
    if (!prefs.flightsLayer) return null;
    const out: Flight[] = [];
    for (const f of onMap) {
      const zone = tzOf(f.summary);
      for (const x of flightsOf(f.summary)) {
        if (dateWindow) {
          const d = dayKey(x.start, zone);
          if ((dateWindow.from && d < dateWindow.from) || (dateWindow.to && d > dateWindow.to)) continue;
        }
        out.push(x);
      }
    }
    return out;
  }, [onMap, prefs.flightsLayer, dateWindow, prefs.tzMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedEntry = useMemo(
    () => (selected ? (colored.find((f) => f.summary.path === selected) ?? null) : null),
    [colored, selected],
  );

  const dateLegend = useMemo(() => {
    if (prefs.colorMode !== "date") return null;
    const ts = files.map((f) => f.summary.stats.startTime).filter((t): t is number => t != null);
    if (ts.length === 0) return null;
    return [Math.min(...ts), Math.max(...ts)] as const;
  }, [files, prefs.colorMode]);

  const shownRef = useRef(shown);
  shownRef.current = shown;

  /** Etkin güzergâh filtresinin açıklaması (güzergâhın ilk kaydının yeri/adı). */
  const routeLabel = useMemo(() => {
    const f = activeRoute && files.find((x) => x.summary.path === activeRoute.paths[0]);
    return f ? (placeLabel(f.summary) ?? f.summary.name ?? f.summary.fileName) : null;
  }, [activeRoute, files]);

  const coloredByPath = useMemo(() => new Map(colored.map((f) => [f.summary.path, f])), [colored]);
  const coloredByPathRef = useRef(coloredByPath);
  coloredByPathRef.current = coloredByPath;
  const summaryOf = useCallback((p: string) => coloredByPathRef.current.get(p)?.summary, []);
  const libraryFlights = useMemo(() => summaries.reduce((n, s) => n + flightsOf(s).length, 0), [summaries]);
  /** Seçili kayıtla çakışanlar (ad ve ortak süreyle). */
  const selOverlaps = useMemo(
    () =>
      selected
        ? (overlapInfo.get(selected) ?? []).flatMap((o) => {
            const f = coloredByPath.get(o.path);
            return f ? [{ path: o.path, ms: o.ms, name: f.summary.name || f.summary.fileName, color: f.color }] : [];
          })
        : [],
    [selected, overlapInfo, coloredByPath],
  );

  return {
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
  };
}
