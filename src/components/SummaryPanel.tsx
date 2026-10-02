import { useMemo, useState } from "react";
import type { FileEntry } from "../types";
import {
  MONTHS,
  fmtDate,
  fmtDistance,
  fmtDuration,
  fmtElevation,
  fmtNumber,
  fmtSpeed,
  monthLabel,
  tzOf,
} from "../format";
import { periodRange } from "./DateRange";
import { dayBuckets, dayIn, rangeShare } from "../days";
import { Modal } from "./Modal";
import { CalendarHeatmap } from "./CalendarHeatmap";
import { ACTIVITIES, placeLabel } from "../types";
import type { Route } from "../routes";
import type { NamedPlace } from "../api";
import { dayKey, isoToTr } from "../format";
import { fastDayKey } from "../days";
import { endName, flightsOf, type Flight } from "../flights";
import { namedPlaceAt } from "../places";
import { countryName, flagOf, hourPlaces } from "../visits";

const FLIGHT_ROWS = 200;
const TOP_CITIES = 8;

type Period = "month" | "year";
type Measure = "distance" | "moving" | "gain" | "count";

const MEASURES: { id: Measure; label: string; fmt(v: number): string; axis(v: number): string }[] = [
  { id: "distance", label: "Mesafe", fmt: (v) => fmtDistance(v), axis: (v) => `${fmtNumber(v / 1000)} km` },
  { id: "moving", label: "Hareket süresi", fmt: (v) => fmtDuration(v), axis: (v) => `${fmtNumber(v / 3_600_000)} sa` },
  { id: "gain", label: "Tırmanış", fmt: (v) => fmtElevation(v), axis: (v) => `${fmtNumber(v)} m` },
  { id: "count", label: "Kayıt sayısı", fmt: (v) => `${fmtNumber(v)} kayıt`, axis: (v) => fmtNumber(v) },
];

interface Bucket {
  key: string;
  label: string;
  short: string;
  distance: number;
  moving: number;
  gain: number;
  count: number;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

interface Props {
  files: FileEntry[];
  /** Kenar çubuğundaki tarih filtresi ("" = sınırsız). */
  from: string;
  to: string;
  routes: Route[];
  onPeriod(from: string, to: string): void;
  onOpen(path: string): void;
  onRoute(route: Route): void;
  onActivity(id: string): void;
  onClose(): void;
  places: NamedPlace[];
  onFlight(f: Flight): void;
}

interface YearVisits {
  year: string;
  countries: { cc: string; days: number }[];
  cities: { cc: string; name: string; days: number }[];
}

/** Ülke ve şehirlerde geçen günler (yer dökümü olan saatlerden). */
function visitedPlaces(files: FileEntry[], from: string, to: string) {
  const years = new Map<string, { countries: Map<string, Set<string>>; cities: Map<string, Set<string>> }>();
  const first = new Map<string, string>();
  const allDays = new Map<string, Set<string>>();
  for (const f of files) {
    const s = f.summary;
    const hp = hourPlaces(s);
    if (!hp.length) continue;
    const zone = tzOf(s);
    const start = s.stats.startTime;
    for (const x of hp) {
      if (!x.cc && !x.name) continue;
      const day = fastDayKey(start != null ? Math.max(x.h, start) : x.h, zone);
      if (!dayIn(day, from, to)) continue;
      const y = day.slice(0, 4);
      let yv = years.get(y);
      if (!yv) years.set(y, (yv = { countries: new Map(), cities: new Map() }));
      const cc = x.cc.toUpperCase();
      if (cc) {
        let cs = yv.countries.get(cc);
        if (!cs) yv.countries.set(cc, (cs = new Set()));
        cs.add(day);
        let all = allDays.get(cc);
        if (!all) allDays.set(cc, (all = new Set()));
        all.add(day);
        const fd = first.get(cc);
        if (!fd || day < fd) first.set(cc, day);
      }
      if (x.name) {
        const k = `${cc}|${x.name}`;
        let ci = yv.cities.get(k);
        if (!ci) yv.cities.set(k, (ci = new Set()));
        ci.add(day);
      }
    }
  }
  const out: YearVisits[] = [...years.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([year, v]) => ({
      year,
      countries: [...v.countries.entries()].map(([cc, d]) => ({ cc, days: d.size })).sort((a, b) => b.days - a.days),
      cities: [...v.cities.entries()]
        .map(([k, d]) => {
          const i = k.indexOf("|");
          return { cc: k.slice(0, i), name: k.slice(i + 1), days: d.size };
        })
        .sort((a, b) => b.days - a.days),
    }));
  const firsts = [...first.entries()]
    .map(([cc, day]) => ({ cc, day, days: allDays.get(cc)?.size ?? 0 }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return { years: out, firsts };
}

/** Adlandırılmış yerlerde ay ay geçen süre (duraklamalardan). */
function timeAtPlaces(files: FileEntry[], places: NamedPlace[], from: string, to: string) {
  const months = new Map<string, Map<string, number>>();
  const totals = new Map<string, number>();
  if (!places.length) return { months: [] as { key: string; by: Map<string, number> }[], totals };
  for (const f of files) {
    const zone = tzOf(f.summary);
    for (const st of f.summary.stops) {
      const p = namedPlaceAt(st.lon, st.lat, places);
      if (!p) continue;
      const day = fastDayKey(st.start, zone);
      if (!dayIn(day, from, to)) continue;
      const m = day.slice(0, 7);
      let by = months.get(m);
      if (!by) months.set(m, (by = new Map()));
      by.set(p.id, (by.get(p.id) ?? 0) + st.durationMs);
      totals.set(p.id, (totals.get(p.id) ?? 0) + st.durationMs);
    }
  }
  return {
    months: [...months.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([key, by]) => ({ key, by })),
    totals,
  };
}

export function SummaryPanel({ files, from, to, routes, onPeriod, onOpen, onRoute, onActivity, onClose, places, onFlight }: Props) {
  const [period, setPeriod] = useState<Period>("month");
  const [measure, setMeasure] = useState<Measure>("distance");
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const dated = useMemo(() => files.filter((f) => f.summary.stats.startTime != null), [files]);

  const buckets = useMemo<Bucket[]>(() => {
    const map = new Map<string, Bucket>();
    const len = period === "month" ? 7 : 4;
    for (const f of dated) {
      const s = f.summary;
      // Birden çok güne yayılan kayıt: mesafe ve süre verisi olan günlere göre
      // dönemlere dağılır; tırmanışın günlük dökümü olmadığından mesafe oranında.
      const days = dayBuckets(s);
      const total = s.stats.distanceM;
      const gain = s.stats.elevationGainM ?? 0;
      let last = "";
      days.forEach((d, i) => {
        if (!dayIn(d.day, from, to)) return;
        const key = d.day.slice(0, len);
        let b = map.get(key);
        if (!b) {
          b = { key, label: "", short: "", distance: 0, moving: 0, gain: 0, count: 0 };
          map.set(key, b);
        }
        b.distance += d.distanceM;
        b.moving += d.movingMs;
        b.gain += total > 0 ? (gain * d.distanceM) / total : i === 0 ? gain : 0;
        // Kayıt, dokunduğu her dönemde bir kez sayılır (günler sıralı).
        if (key !== last) b.count += 1;
        last = key;
      });
    }
    if (map.size === 0) return [];
    // Boş dönemler de eksende yer alsın ki aralar görünsün.
    const keys = [...map.keys()].sort();
    const out: Bucket[] = [];
    const empty = (key: string): Bucket => ({ key, label: "", short: "", distance: 0, moving: 0, gain: 0, count: 0 });
    if (period === "year") {
      for (let y = Number(keys[0]); y <= Number(keys[keys.length - 1]); y++) out.push(map.get(String(y)) ?? empty(String(y)));
    } else {
      let [y, m] = keys[0].split("-").map(Number);
      const [ey, em] = keys[keys.length - 1].split("-").map(Number);
      while (y < ey || (y === ey && m <= em)) {
        const key = `${y}-${String(m).padStart(2, "0")}`;
        out.push(map.get(key) ?? empty(key));
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }
    for (const b of out) {
      if (period === "year") {
        b.label = b.key;
        b.short = b.key;
      } else {
        b.label = monthLabel(b.key);
        const mi = Number(b.key.slice(5)) - 1;
        b.short = mi === 0 ? `${MONTHS[0].slice(0, 3)} ${b.key.slice(2, 4)}` : MONTHS[mi].slice(0, 3);
      }
    }
    return out;
  }, [dated, period, from, to]);

  const totals = useMemo(() => {
    let distance = 0,
      moving = 0,
      gain = 0;
    const days = new Set<string>();
    let partial = 0;
    for (const f of files) {
      const part = rangeShare(f.summary, from, to);
      distance += part.distanceM;
      moving += part.movingMs;
      gain += part.gainM;
      if (part.partial) partial++;
      for (const d of dayBuckets(f.summary)) if (dayIn(d.day, from, to)) days.add(d.day);
    }
    return { distance, moving, gain, days: days.size, count: files.length, partial };
  }, [files, from, to]);

  const records = useMemo(() => {
    const best = (score: (f: FileEntry) => number | null) => {
      let top: FileEntry | null = null;
      let v = -Infinity;
      for (const f of files) {
        const x = score(f);
        if (x != null && x > v) {
          v = x;
          top = f;
        }
      }
      return top;
    };
    const rows: { label: string; f: FileEntry | null; value: (f: FileEntry) => string }[] = [
      { label: "En uzun mesafe", f: best((f) => f.summary.stats.distanceM), value: (f) => fmtDistance(f.summary.stats.distanceM) },
      { label: "En uzun süre", f: best((f) => f.summary.stats.movingMs), value: (f) => fmtDuration(f.summary.stats.movingMs) },
      {
        label: "En hızlı (ort., 1 km üstü)",
        f: best((f) => (f.summary.stats.distanceM >= 1000 ? f.summary.stats.avgMovingSpeedMs : null)),
        value: (f) => fmtSpeed(f.summary.stats.avgMovingSpeedMs),
      },
      { label: "En çok tırmanış", f: best((f) => f.summary.stats.elevationGainM), value: (f) => fmtElevation(f.summary.stats.elevationGainM) },
      { label: "En yüksek nokta", f: best((f) => f.summary.stats.maxEleM), value: (f) => fmtElevation(f.summary.stats.maxEleM) },
    ];
    return rows.filter((r) => r.f);
  }, [files]);

  const byPath = useMemo(() => new Map(files.map((f) => [f.summary.path, f])), [files]);
  /** Gösterilen kayıtların tarih aralığına düşen uçuşları. */
  const flights = useMemo(() => {
    const list: Flight[] = [];
    for (const f of files) {
      const zone = tzOf(f.summary);
      for (const x of flightsOf(f.summary)) if (dayIn(dayKey(x.start, zone), from, to)) list.push(x);
    }
    list.sort((a, b) => a.start - b.start);
    const years = new Map<string, { n: number; m: number }>();
    for (const x of list) {
      const y = dayKey(x.start, tzOf(byPath.get(x.path)?.summary)).slice(0, 4);
      const t = years.get(y) ?? { n: 0, m: 0 };
      t.n++;
      t.m += x.distanceM;
      years.set(y, t);
    }
    return { list, years: [...years.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)) };
  }, [files, from, to, byPath]);
  const visited = useMemo(() => visitedPlaces(files, from, to), [files, from, to]);
  const placeTime = useMemo(() => timeAtPlaces(files, places, from, to), [files, places, from, to]);
  const usedPlaces = places.filter((p) => placeTime.totals.has(p.id));

  const m = MEASURES.find((x) => x.id === measure)!;
  const val = (b: Bucket) => b[measure];
  const max = niceMax(Math.max(0, ...buckets.map(val)));
  const peak = buckets.reduce((bi, b, i) => (val(b) > val(buckets[bi] ?? b) ? i : bi), 0);

  // Grafik ölçüleri
  const slot = period === "month" ? 34 : 64;
  const padL = 56;
  const padB = 26;
  const padT = 18;
  const h = 220;
  const w = Math.max(560, padL + buckets.length * slot + 8);
  const barW = Math.min(24, slot * 0.7);
  const y = (v: number) => padT + (h - padT - padB) * (1 - v / max);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  const pick = (b: Bucket) => {
    const [yy, mm] = b.key.split("-").map(Number);
    onPeriod(...periodRange(yy, period === "month" ? mm - 1 : null));
  };

  return (
    <Modal title="Özet" onClose={onClose} wide>
      <div className="summary">
        <div className="tiles">
          <div className="tile">
            <span>Kayıt</span>
            <strong>{fmtNumber(totals.count)}</strong>
          </div>
          <div className="tile">
            <span>Etkin gün</span>
            <strong>{fmtNumber(totals.days)}</strong>
          </div>
          <div className="tile">
            <span>Toplam mesafe</span>
            <strong>{fmtDistance(totals.distance)}</strong>
          </div>
          <div className="tile">
            <span>Hareket süresi</span>
            <strong>{fmtDuration(totals.moving)}</strong>
          </div>
          <div className="tile">
            <span>Toplam tırmanış</span>
            <strong>{fmtElevation(totals.gain)}</strong>
          </div>
          <div className="tile">
            <span>Kayıt başına</span>
            <strong>{fmtDistance(totals.count ? totals.distance / totals.count : 0)}</strong>
          </div>
        </div>
        <p className="muted small-note">
          Kenar çubuğundaki filtreye uyan {fmtNumber(files.length)} kayıt.
          {totals.partial > 0 &&
            ` Tarih aralığının dışına taşan ${fmtNumber(totals.partial)} kaydın yalnızca aralıktaki günleri sayıldı (tırmanış mesafe oranında).`}
          {" "}Birden çok güne yayılan kayıtlar, verisi olan her güne ve döneme dağıtılır.
        </p>

        <div className="type-tiles">
          {ACTIVITIES.map((a) => {
            const list = files.filter((f) => f.summary.activity === a.id);
            if (!list.length) return null;
            const dist = list.reduce((x, f) => x + rangeShare(f.summary, from, to).distanceM, 0);
            return (
              <button key={a.id} className="type-tile" onClick={() => onActivity(a.id)} title="Listeyi bu türe göre filtrele">
                <span>
                  {a.icon} {a.label}
                </span>
                <strong>{fmtNumber(list.length)}</strong>
                <small>{fmtDistance(dist)}</small>
              </button>
            );
          })}
        </div>

        <h3 className="chart-title">Takvim</h3>
        <CalendarHeatmap files={files} from={from} to={to} onDay={(iso) => onPeriod(iso, iso)} />

        <div className="filter-row summary-controls">
          <div className="segmented small">
            <button className={period === "month" ? "active" : ""} onClick={() => setPeriod("month")}>
              Aylık
            </button>
            <button className={period === "year" ? "active" : ""} onClick={() => setPeriod("year")}>
              Yıllık
            </button>
          </div>
          <div className="segmented small">
            {MEASURES.map((x) => (
              <button key={x.id} className={measure === x.id ? "active" : ""} onClick={() => setMeasure(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} />
            Tablo olarak
          </label>
        </div>

        <h3 className="chart-title">
          {period === "month" ? "Aylık" : "Yıllık"} {m.label.toLocaleLowerCase("tr-TR")}
        </h3>
        {buckets.length === 0 ? (
          <div className="chart-empty">Tarihli kayıt yok.</div>
        ) : asTable ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Dönem</th>
                  <th>Kayıt</th>
                  <th>Mesafe</th>
                  <th>Hareket süresi</th>
                  <th>Tırmanış</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.key} onClick={() => b.count && pick(b)} className={b.count ? "clickable" : ""}>
                    <td>{b.label}</td>
                    <td>{fmtNumber(b.count)}</td>
                    <td>{fmtDistance(b.distance)}</td>
                    <td>{fmtDuration(b.moving)}</td>
                    <td>{fmtElevation(b.gain)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="bars-wrap">
            <svg width={w} height={h} role="img" aria-label={`${m.label} dönemlere göre`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={padL} x2={w - 4} y1={y(t)} y2={y(t)} className="grid" />
                  <text x={padL - 6} y={y(t) + 4} className="axis" textAnchor="end">
                    {m.axis(t)}
                  </text>
                </g>
              ))}
              {buckets.map((b, i) => {
                const v = val(b);
                const x = padL + i * slot + (slot - barW) / 2;
                const top = y(v);
                const bh = h - padB - top;
                const r = Math.min(4, bh);
                const path =
                  bh <= 0
                    ? ""
                    : `M${x},${h - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${h - padB} Z`;
                return (
                  <g
                    key={b.key}
                    className={`bar${hover === i ? " hover" : ""}`}
                    onMouseEnter={() => setHover(i)}
                    onMouseLeave={() => setHover(null)}
                    onClick={() => b.count && pick(b)}
                  >
                    {/* Tıklama alanı çubuktan geniş. */}
                    <rect x={padL + i * slot} y={padT} width={slot} height={h - padT - padB} fill="transparent" />
                    {path && <path d={path} />}
                    {(i === peak || hover === i) && v > 0 && (
                      <text x={x + barW / 2} y={top - 5} textAnchor="middle" className="value">
                        {m.fmt(v)}
                      </text>
                    )}
                    <text x={x + barW / 2} y={h - 8} textAnchor="middle" className="axis">
                      {b.short}
                    </text>
                  </g>
                );
              })}
            </svg>
            {hover != null && buckets[hover] && (
              <div className="bar-tip" style={{ left: padL + hover * slot + slot / 2 }}>
                <strong>{buckets[hover].label}</strong>
                <span>{fmtNumber(buckets[hover].count)} kayıt</span>
                <span>{fmtDistance(buckets[hover].distance)}</span>
                <span>{fmtDuration(buckets[hover].moving)}</span>
                <span>↗ {fmtElevation(buckets[hover].gain)}</span>
                {buckets[hover].count > 0 && <em>Tıklayınca bu döneme filtrelenir</em>}
              </div>
            )}
          </div>
        )}

        {routes.length > 0 && (
          <>
            <h3 className="chart-title">Sık güzergâhlar</h3>
            <ul className="records">
              {routes.slice(0, 6).map((r) => {
                const f = files.find((x) => x.summary.path === r.paths[0]) ?? files.find((x) => r.paths.includes(x.summary.path));
                if (!f) return null;
                const timed = r.paths
                  .map((p) => files.find((x) => x.summary.path === p)?.summary.stats.movingMs)
                  .filter((v): v is number => v != null);
                return (
                  <li key={r.id}>
                    <span className="muted">{fmtNumber(r.paths.length)} kez</span>
                    <button className="link" onClick={() => onRoute(r)}>
                      <span className="swatch" style={{ background: f.color }} />
                      {placeLabel(f.summary) ?? f.summary.name ?? f.summary.fileName}
                      <span className="muted"> · {fmtDistance(f.summary.stats.distanceM)}</span>
                    </button>
                    <strong>{timed.length ? `en iyi ${fmtDuration(Math.min(...timed))}` : ""}</strong>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <h3 className="chart-title">✈ Uçuşlar</h3>
        {flights.list.length === 0 ? (
          <div className="muted small-note">
            Uçuş bulunamadı. Ortalama hızı 300 km/sa'i aşan, 100 km'den uzun kayıt boşlukları uçuş sayılır.
          </div>
        ) : (
          <>
            <div className="year-totals">
              {flights.years.map(([y, t]) => (
                <span key={y} className="chip">
                  <strong>{y}</strong> {fmtNumber(t.n)} uçuş · {fmtDistance(t.m)}
                </span>
              ))}
            </div>
            <div className="table-wrap">
              <table className="data-table compact flights-table">
                <thead>
                  <tr>
                    <th>Tarih</th>
                    <th>Nereden → nereye</th>
                    <th>Mesafe</th>
                    <th>Süre</th>
                  </tr>
                </thead>
                <tbody>
                  {flights.list.slice(-FLIGHT_ROWS).reverse().map((x) => {
                    const f = byPath.get(x.path);
                    return (
                      <tr
                        key={`${x.path}#${x.gap}`}
                        className="clickable"
                        onClick={() => onFlight(x)}
                        title={`${f?.summary.name || f?.summary.fileName || ""} · tıklayınca kayıt seçilir ve uçuşa yakınlaşılır`}
                      >
                        <td>{fmtDate(x.start, tzOf(f?.summary))}</td>
                        <td>
                          {f && <span className="swatch" style={{ background: f.color }} />} {endName(x, "from")} →{" "}
                          {endName(x, "to")}
                        </td>
                        <td>{fmtDistance(x.distanceM)}</td>
                        <td>{fmtDuration(x.durationMs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {flights.list.length > FLIGHT_ROWS && (
              <div className="muted small-note">Son {fmtNumber(FLIGHT_ROWS)} uçuş gösteriliyor.</div>
            )}
          </>
        )}

        <h3 className="chart-title">Gezilen ülkeler ve şehirler</h3>
        {visited.years.length === 0 ? (
          <div className="muted small-note">
            Yer bilgisi yok. Kayıtların saat saat hangi ülke ve şehirde geçtiği, kayıtlar yeniden hesaplandığında eklenir.
          </div>
        ) : (
          <div className="visited">
            {visited.years.map((y) => (
              <div key={y.year} className="visited-year">
                <strong className="visited-y">{y.year}</strong>
                <div>
                  <div className="visited-countries">
                    {y.countries.map((c) => (
                      <span key={c.cc} className="chip" title={`${countryName(c.cc)}: ${fmtNumber(c.days)} gün`}>
                        {flagOf(c.cc)} {countryName(c.cc)} · {fmtNumber(c.days)} gün
                      </span>
                    ))}
                  </div>
                  {y.cities.length > 0 && (
                    <div className="muted visited-cities">
                      {y.cities
                        .slice(0, TOP_CITIES)
                        .map((c) => `${c.name} (${fmtNumber(c.days)} gün)`)
                        .join(" · ")}
                      {y.cities.length > TOP_CITIES && ` · +${fmtNumber(y.cities.length - TOP_CITIES)} yer`}
                    </div>
                  )}
                </div>
              </div>
            ))}
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Ülke</th>
                  <th>İlk ziyaret</th>
                  <th>Toplam gün</th>
                </tr>
              </thead>
              <tbody>
                {visited.firsts.map((c) => (
                  <tr key={c.cc}>
                    <td>
                      {flagOf(c.cc)} {countryName(c.cc)}
                    </td>
                    <td>{isoToTr(c.day)}</td>
                    <td>{fmtNumber(c.days)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="chart-title">Yerlerde geçen süre</h3>
        {places.length === 0 ? (
          <div className="muted small-note">
            Adlandırılmış yer yok. Haritada bir duraklamaya ya da sık durulan yere tıklayıp “Bu yere ad ver…” ile ekleyin.
          </div>
        ) : usedPlaces.length === 0 ? (
          <div className="muted small-note">Gösterilen kayıtlarda adlandırılmış yerlerde duraklama yok.</div>
        ) : (
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Ay</th>
                  {usedPlaces.map((p) => (
                    <th key={p.id}>{p.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {placeTime.months.map((mo) => (
                  <tr key={mo.key}>
                    <td>{monthLabel(mo.key)}</td>
                    {usedPlaces.map((p) => (
                      <td key={p.id}>{mo.by.has(p.id) ? fmtDuration(mo.by.get(p.id)) : ""}</td>
                    ))}
                  </tr>
                ))}
                <tr className="total-row">
                  <th>Toplam</th>
                  {usedPlaces.map((p) => (
                    <th key={p.id}>{fmtDuration(placeTime.totals.get(p.id) ?? 0)}</th>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <h3 className="chart-title">Rekorlar</h3>
        <ul className="records">
          {records.map((r) => (
            <li key={r.label}>
              <span className="muted">{r.label}</span>
              <button className="link" onClick={() => onOpen(r.f!.summary.path)}>
                <span className="swatch" style={{ background: r.f!.color }} />
                {r.f!.summary.name || r.f!.summary.fileName}
                <span className="muted"> · {fmtDate(r.f!.summary.stats.startTime, tzOf(r.f!.summary))}</span>
              </button>
              <strong>{r.value(r.f!)}</strong>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
