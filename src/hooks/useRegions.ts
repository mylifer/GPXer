import { useEffect, useMemo, useState } from "react";
import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FileEntry } from "../types";
import {
  ccOf,
  loadCountries,
  loadProvinces,
  loadWorldRegions,
  regionCounts,
  visitedProvinces,
  type CountryFC,
  type ProvinceFC,
  type ProvinceVisit,
} from "../regions";
import { visitedPlaces } from "../summary";

/** Bir ülkede gezilen bölgeler (Türkiye dışı). */
export interface AbroadRegions {
  cc: string;
  /** Ülkenin birinci düzey bölge sayısı. */
  total: number;
  visits: ProvinceVisit[];
}

export interface RegionData {
  /** Gezilen ülkeler (yalnızca onlar). */
  countries: FeatureCollection<MultiPolygon, { cc: string }>;
  /** Türkiye illeri ve gezilen öteki ülkelerin bölgeleri; `visited` gezilenlerde 1. */
  provinces: FeatureCollection<MultiPolygon, { name: string; visited: number }>;
  /** Türkiye'de gezilen iller. */
  provinceVisits: ProvinceVisit[];
  /** Öteki ülkelerde gezilen bölgeler (ilk giriş sırasıyla ülke ülke). */
  abroad: AbroadRegions[];
  countryCodes: string[];
}

/** Gezilen il, bölge ve ülkeler (gösterilen kayıtlar ve tarih filtresine göre).
 * `on` kapalıyken sınır verisi yüklenmez; öteki ülkelerin bölgeleri yalnızca
 * yurtdışı kayıt varsa yüklenir. */
export function useRegions(files: FileEntry[], from: string, to: string, on: boolean): RegionData | null {
  const [fc, setFc] = useState<{ provinces: ProvinceFC; countries: CountryFC } | null>(null);
  const [world, setWorld] = useState<ProvinceFC | null>(null);
  const countryCodes = useMemo(() => (on ? visitedPlaces(files, from, to).firsts.map((c) => c.cc) : []), [on, files, from, to]);
  // Yer dökümü olmayan (eski önbellekteki) kayıtlar için: Türkiye'nin kabaca
  // sınır kutusu dışında başlayan ya da biten kayıt.
  const abroad = useMemo(
    () =>
      countryCodes.some((c) => c !== "TR") ||
      (on &&
        files.some(({ summary: { lines } }) => {
          const end = lines[lines.length - 1];
          return [lines[0]?.[0], end?.[end.length - 1]].some((p) => p && !(p[0] > 25.5 && p[0] < 45 && p[1] > 35.7 && p[1] < 42.2));
        })),
    [on, countryCodes, files],
  );
  useEffect(() => {
    if (!on || fc) return;
    let live = true;
    Promise.all([loadProvinces(), loadCountries()])
      .then(([provinces, countries]) => live && setFc({ provinces, countries }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [on, fc]);
  useEffect(() => {
    if (!on || !abroad || world) return;
    let live = true;
    loadWorldRegions()
      .then((w) => live && setWorld(w))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [on, abroad, world]);
  const counts = useMemo(() => (world ? regionCounts(world) : null), [world]);
  return useMemo(() => {
    if (!on || !fc) return null;
    const regionsFc = abroad && world ? world : fc.provinces;
    const all = visitedProvinces(
      files.map((f) => f.summary),
      regionsFc,
      from,
      to,
    );
    const provinceVisits = all.filter((v) => v.cc === "TR");
    const codes = [...countryCodes];
    // Kayıtta yer dökümü yoksa (eski önbellek) bölge geçişi de ülkeyi gösterir.
    for (const v of all) if (!codes.includes(v.cc)) codes.push(v.cc);
    const byCc = new Map<string, ProvinceVisit[]>();
    for (const v of all) {
      if (v.cc === "TR") continue;
      const list = byCc.get(v.cc);
      if (list) list.push(v);
      else byCc.set(v.cc, [v]);
    }
    const cc = new Set(codes);
    const seen = new Set(all.map((v) => v.key));
    return {
      countries: { type: "FeatureCollection", features: fc.countries.features.filter((f) => cc.has(f.properties.cc)) },
      provinces: {
        type: "FeatureCollection",
        // Yalnızca gezilen ülkelerin bölgeleri (bütün dünyanın sınırları haritayı boğar).
        features: regionsFc.features
          .filter((f) => ccOf(f.properties) === "TR" || cc.has(ccOf(f.properties)))
          .map((f) => ({
            ...f,
            properties: { name: f.properties.name, visited: seen.has(`${ccOf(f.properties)}|${f.properties.name}`) ? 1 : 0 },
          })),
      },
      provinceVisits,
      abroad: [...byCc].map(([c, visits]) => ({ cc: c, total: counts?.get(c) ?? visits.length, visits })),
      countryCodes: codes,
    };
  }, [on, fc, world, counts, abroad, countryCodes, files, from, to]);
}
