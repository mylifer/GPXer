import { useMemo } from "react";
import type { Detail } from "../api";
import { METRICS, SEQ_DARK, SEQ_LIGHT } from "../types";
import type { TrackColorBy } from "../prefs";
import { fmtDate, fmtNumber, fmtUnit } from "../format";
import type { RegionData } from "../hooks/useRegions";
import { PROVINCE_COUNT } from "../regions";
import { metricDomain } from "../map/geojson";

/** Haritanın altındaki renk açıklamaları (ısı haritası, tarih, seçili izin ölçüsü). */
export function MapLegends({
  heatmap,
  dark,
  dateLegend,
  detail,
  trackColorBy,
  regions,
}: {
  regions: RegionData | null;
  heatmap: boolean;
  dark: boolean;
  dateLegend: readonly [number, number] | null;
  detail: Detail | null;
  trackColorBy: TrackColorBy;
}) {
  const metricLegend = useMemo(() => {
    if (!detail || trackColorBy === "none") return null;
    const d = metricDomain(detail[trackColorBy] as (number | null)[]);
    return d ? { metric: METRICS[trackColorBy], domain: d } : null;
  }, [detail, trackColorBy]);

  const ramp = dark ? SEQ_DARK : SEQ_LIGHT;
  const gradient = `linear-gradient(to right, ${ramp.join(", ")})`;

  return (
    <div className="legends">
      {regions && (
        <div className="legend">
          <span className="legend-title">Gezilen yerler</span>
          <div className="legend-regions">
            <span>
              <i className="sw" style={{ background: "rgba(232,116,59,0.45)" }} /> {fmtNumber(regions.provinceVisits.length)} / {PROVINCE_COUNT} il
            </span>
            <span>
              <i className="sw" style={{ background: "rgba(60,120,216,0.3)" }} /> {fmtNumber(regions.countryCodes.length)} ülke
            </span>
          </div>
        </div>
      )}
      {heatmap && (
        <div className="legend">
          <span className="legend-title">Geçiş yoğunluğu</span>
          <div className="legend-bar" style={{ background: gradient }} />
          <div className="legend-ends">
            <span>az</span>
            <span>çok</span>
          </div>
        </div>
      )}
      {!heatmap && dateLegend && (
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
  );
}
