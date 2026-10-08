import { useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import { addGpxRecord, planRoute, type LoadResult } from "../api";
import type { PlanState } from "../components/PlanPanel";
import { fmtDistance, isoOf, isoToTr } from "../format";
import type { FileEntry } from "../types";

/** Rota planı: noktalar değişince yol tarifi alınır; plan kütüphaneye kaydedilir. */
export function usePlanRoute({
  plan,
  setPlan,
  addResults,
  say,
  fail,
  selectAndZoom,
}: {
  plan: PlanState | null;
  setPlan: Dispatch<SetStateAction<PlanState | null>>;
  addResults(results: LoadResult[]): FileEntry[];
  say(msg: string): void;
  fail(message: string): void;
  selectAndZoom(path: string): void;
}) {
  const planKey = plan ? JSON.stringify([plan.profile, plan.points]) : "";
  useEffect(() => {
    if (!plan) return;
    if (plan.points.length < 2) {
      setPlan((s) => s && { ...s, route: null, busy: false, error: null });
      return;
    }
    setPlan((s) => s && { ...s, busy: true, error: null });
    let live = true;
    const t = setTimeout(() => {
      planRoute(
        plan.profile,
        plan.points.map(([lon, lat]) => [lat, lon]),
      )
        .then((route) => live && setPlan((s) => s && { ...s, route, busy: false }))
        .catch((e) => live && setPlan((s) => s && { ...s, route: null, busy: false, error: String(e) }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [planKey]);
  const savePlan = useCallback(async () => {
    const r = plan?.route;
    if (!plan || !r || plan.busy) return;
    // Kaydedilirken düğme kapalı: çift tıklama iki kayıt eklemesin.
    setPlan((s) => s && { ...s, busy: true });
    const label = { car: "araç", bike: "bisiklet", foot: "yaya" }[plan.profile];
    const name = `Plan (${label}) ${fmtDistance(r.distanceM)} · ${isoToTr(isoOf(new Date()))}`;
    const pts = r.coords.map(([lat, lon]) => `<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"/>`).join("\n");
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GPXer" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${name}</name></metadata>
${plan.points.map(([lon, lat], i) => `<wpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><name>${i + 1}</name></wpt>`).join("\n")}
<trk><name>${name}</name><type>plan</type><trkseg>
${pts}
</trkseg></trk>
</gpx>`;
    try {
      const added = addResults([await addGpxRecord(name, gpx)]);
      if (added[0]) {
        say("Plan kütüphaneye eklendi; GPX olarak dışa aktarılabilir ya da gerçek kayıtla karşılaştırılabilir.");
        setPlan(null);
        selectAndZoom(added[0].summary.path);
        return;
      }
    } catch (e) {
      fail(String(e));
    }
    setPlan((s) => s && { ...s, busy: false });
  }, [plan, addResults, say, fail, selectAndZoom]);
  return savePlan;
}
