import { useEffect, useMemo, useState } from "react";
import type { FeatureCollection, MultiPolygon } from "geojson";
import type { FileEntry } from "../types";
import { loadCountries, loadProvinces, visitedProvinces, type CountryFC, type ProvinceFC, type ProvinceVisit } from "../regions";
import { visitedPlaces } from "../summary";

export interface RegionData {
  /** Gezilen ülkeler (yalnızca onlar). */
  countries: FeatureCollection<MultiPolygon, { cc: string }>;
  /** Tüm iller; `visited` gezilenlerde 1. */
  provinces: FeatureCollection<MultiPolygon, { name: string; visited: number }>;
  provinceVisits: ProvinceVisit[];
  countryCodes: string[];
}

/** Gezilen il ve ülkeler (gösterilen kayıtlar ve tarih filtresine göre).
 * `on` kapalıyken sınır verisi yüklenmez. */
export function useRegions(files: FileEntry[], from: string, to: string, on: boolean): RegionData | null {
  const [fc, setFc] = useState<{ provinces: ProvinceFC; countries: CountryFC } | null>(null);
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
  return useMemo(() => {
    if (!on || !fc) return null;
    const provinceVisits = visitedProvinces(
      files.map((f) => f.summary),
      fc.provinces,
      from,
      to,
    );
    const seen = new Set(provinceVisits.map((v) => v.name));
    const countryCodes = visitedPlaces(files, from, to).firsts.map((c) => c.cc);
    // Kayıtta yer dökümü yoksa (eski önbellek) Türkiye'deki il geçişi yeter.
    if (seen.size && !countryCodes.includes("TR")) countryCodes.push("TR");
    const cc = new Set(countryCodes);
    return {
      countries: { type: "FeatureCollection", features: fc.countries.features.filter((f) => cc.has(f.properties.cc)) },
      provinces: {
        type: "FeatureCollection",
        features: fc.provinces.features.map((f) => ({
          ...f,
          properties: { name: f.properties.name, visited: seen.has(f.properties.name) ? 1 : 0 },
        })),
      },
      provinceVisits,
      countryCodes,
    };
  }, [on, fc, files, from, to]);
}
