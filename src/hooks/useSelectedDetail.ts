import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { loadDetail, rangeStats, type Detail, type FileSummary, type Stats } from "../api";
import type { MapHandle } from "../components/MapView";
import type { Cursor } from "../components/CompareView";
import type { Prefs } from "../prefs";
import { detailDays } from "../days";
import type { IdxStore } from "../lib/idxStore";

/** Oynatmada kayıttaki bu uzunluktan büyük zaman boşlukları (duraklama,
 * sinyal kaybı) beklenmez; kısa bir sıçramayla geçilir. */
const PLAY_MAX_GAP_MS = 60_000;
const PLAY_GAP_AS_MS = 1_000;

/**
 * Seçili kaydın ayrıntısı (grafik verisi), imleç, seçilen aralık ve oynatma.
 * `oneDay`: tarih filtresi tek güne ayarlıysa o gün (yoksa "").
 */
export function useSelectedDetail({
  selected,
  cursor,
  mapRef,
  prefsRef,
  oneDay,
  selSummary,
}: {
  selected: string | null;
  cursor: IdxStore;
  mapRef: RefObject<MapHandle | null>;
  prefsRef: RefObject<Prefs>;
  oneDay: string;
  selSummary: FileSummary | null;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [range, setRange] = useState<[number, number] | null>(null);
  /** Aralık istatistiği, hesaplandığı aralık ve ayrıntıyla birlikte: başka bir
   * aralığa aitse gösterilmez (efektte sıfırlamaya gerek kalmaz). */
  const [rangeRes, setRangeRes] = useState<{ range: [number, number]; detail: Detail; st: Stats } | null>(null);
  const rangeSt = rangeRes && rangeRes.range === range && rangeRes.detail === detail ? rangeRes.st : null;
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(playing);
  playingRef.current = playing;
  /** "Tarihe git": ayrıntı yüklenince imlecin konacağı an. */
  const [seek, setSeek] = useState<{ path: string; t: number } | null>(null);

  // Seçim değişince bağlı durum çizim sırasında sıfırlanır (efektte sıfırlamak her
  // seçimde fazladan bir eşzamanlı güncelleme zinciri doğuruyordu; ↑/↓ basılı
  // tutulunca React'in güncelleme sınırına takılıyordu).
  const [detailOf, setDetailOf] = useState(selected);
  if (detailOf !== selected) {
    setDetailOf(selected);
    setDetail(null);
    setDetailError(null);
    setRange(null);
    setPlaying(false);
    // Başka kayda ait, kullanılmamış "Tarihe git" isteği sonra o kayıt
    // açılınca imleci beklenmedik bir ana götürmesin.
    if (seek && seek.path !== selected) setSeek(null);
  }
  useEffect(() => {
    cursor.set(null);
    if (!selected) return;
    let cancelled = false;
    loadDetail(selected)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => {
        if (cancelled) return;
        setDetailError(String(e));
        setSeek(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, cursor]);

  // "Tarihe git": ayrıntı gelince o ana en yakın örneğe imleç konur ve harita ortalanır.
  useEffect(() => {
    if (!seek || !detail || selected !== seek.path) return;
    let best = -1;
    let bestDt = Infinity;
    const times = detail.time;
    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      if (t == null) continue;
      const dt = Math.abs(t - seek.t);
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    setSeek(null);
    if (best < 0) return;
    setPlaying(false);
    cursor.set(best);
    mapRef.current?.centerOn([detail.lon[best], detail.lat[best]]);
  }, [seek, detail, selected, cursor]);

  // Seçili aralığın tam çözünürlüklü istatistiği.
  useEffect(() => {
    if (!range || !detail || !selected) return;
    const [a, b] = [detail.idx[range[0]], detail.idx[range[1]]];
    let cancelled = false;
    const t = setTimeout(() => {
      rangeStats(selected, a, b)
        .then((st) => !cancelled && setRangeRes({ range, detail, st }))
        .catch(() => {});
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [range, detail, selected]);

  // Oynatma: imleci kaydın gerçek zamanına göre (hızlandırılmış) ilerletir.
  useEffect(() => {
    if (!playing || !detail) return;
    const n = detail.lat.length;
    if (n < 2) {
      setPlaying(false);
      return;
    }
    const times = detail.time;
    const timed = times.every((t, i) => t != null && (i === 0 || t >= times[i - 1]!));
    // Oynatma zaman çizelgesi (ms): uzun boşluklar kısaltılır ki imleç
    // duraklamalarda donup kalmasın. Zamansız kayıtlarda 15 km/sa varsayılır.
    const clock = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const d = timed ? times[i]! - times[i - 1]! : ((detail.dist[i] - detail.dist[i - 1]) / 4.17) * 1000;
      clock[i] = clock[i - 1] + (d > PLAY_MAX_GAP_MS ? PLAY_GAP_AS_MS : Math.max(0, d));
    }
    const h = cursor.get();
    let i0 = h != null && h < n - 1 ? h : 0;
    let v = clock[i0];
    const end = clock[n - 1];
    let raf = 0;
    let last: number | null = null;
    const step = (now: number) => {
      // Hız her karede okunur: oynatma sırasında değiştirilebilir.
      if (last != null) v += Math.min(now - last, 250) * prefsRef.current.playSpeed;
      last = now;
      while (i0 < n - 1 && clock[i0 + 1] <= v) i0++;
      cursor.set(i0);
      if (v >= end) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, detail, cursor]);

  /** Fareyle gezinme; oynatma sürerken imleç oynatmanındır. */
  const onHoverIdx = useCallback(
    (i: number | null) => {
      if (!playingRef.current) cursor.set(i);
    },
    [cursor],
  );

  const zoomRange = useCallback(() => {
    if (!detail || !range) return;
    const pts: [number, number][] = [];
    for (let i = range[0]; i <= range[1]; i++) pts.push([detail.lon[i], detail.lat[i]]);
    mapRef.current?.fitPoints(pts);
  }, [detail, range]);

  /** Gün seçimi: aralığı o günün örneklerine ayarlar ve haritada gösterir. */
  const pickDay = useCallback(
    (r: [number, number] | null) => {
      setRange(r);
      if (!detail || !r) return;
      const pts: [number, number][] = [];
      for (let i = r[0]; i <= r[1]; i++) pts.push([detail.lon[i], detail.lat[i]]);
      mapRef.current?.fitPoints(pts);
    },
    [detail],
  );

  // Tarih filtresi tek güne ayarlıysa (ör. takvimde güne tıklama) çok günlü
  // kaydın o günü kendiliğinden seçilir.
  useEffect(() => {
    if (!oneDay || !detail || !selSummary) return;
    const days = detailDays(selSummary, detail);
    if (days.length < 2) return;
    const d = days.find((x) => x.day === oneDay);
    if (d) pickDay([d.start, d.end]);
  }, [oneDay, detail]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    detail,
    detailError,
    range,
    setRange,
    rangeSt,
    playing,
    setPlaying,
    setSeek,
    onHoverIdx,
    zoomRange,
    pickDay,
  };
}

/** Karşılaştırılan iki kaydın grafik verisi ve grafikteki imleçleri. */
export function useCompareDetails(compare: [string, string] | null, fail: (message: string) => void) {
  const [compareDetails, setCompareDetails] = useState<[Detail | null, Detail | null]>([null, null]);
  const [cursors, setCursors] = useState<Cursor[]>([]);
  // Karşılaştırılan iki kaydın grafik verisi.
  useEffect(() => {
    setCompareDetails([null, null]);
    setCursors([]);
    if (!compare) return;
    let cancelled = false;
    Promise.all(compare.map((p) => loadDetail(p)))
      .then(([a, b]) => !cancelled && setCompareDetails([a, b]))
      .catch((e) => !cancelled && fail(String(e)));
    return () => {
      cancelled = true;
    };
  }, [compare]);
  return { compareDetails, cursors, setCursors };
}
