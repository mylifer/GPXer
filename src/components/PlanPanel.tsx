import type { PlannedRoute } from "../api";
import { fmtDistance, fmtDuration } from "../format";

export type PlanProfile = "car" | "bike" | "foot";
export interface PlanState {
  points: [number, number][];
  profile: PlanProfile;
  route: PlannedRoute | null;
  busy: boolean;
  error: string | null;
}

const PROFILES: { id: PlanProfile; label: string }[] = [
  { id: "car", label: "🚗 Araç" },
  { id: "bike", label: "🚴 Bisiklet" },
  { id: "foot", label: "🚶 Yaya" },
];

/** Rota planlama paneli (harita üstünde). */
export function PlanPanel({
  plan,
  onProfile,
  onUndo,
  onClear,
  onSave,
  onClose,
}: {
  plan: PlanState;
  onProfile(p: PlanProfile): void;
  onUndo(): void;
  onClear(): void;
  onSave(): void;
  onClose(): void;
}) {
  const r = plan.route;
  return (
    <div className="plan-panel" role="region" aria-label="Rota planlama">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <strong>Rota planla</strong>
        <button className="icon-btn" onClick={onClose} title="Planlamayı kapat" aria-label="Kapat">
          ×
        </button>
      </div>
      <div className="segmented small">
        {PROFILES.map((p) => (
          <button key={p.id} className={plan.profile === p.id ? "active" : ""} onClick={() => onProfile(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      {plan.points.length < 2 ? (
        <span className="muted">Haritaya tıklayarak noktaları sırayla ekleyin (en az iki). İşaretçiler sürüklenebilir, sağ tıkla silinir.</span>
      ) : plan.busy ? (
        <span className="muted">Rota hesaplanıyor…</span>
      ) : plan.error ? (
        <span className="error">{plan.error}</span>
      ) : r ? (
        <span className="plan-stats">
          {fmtDistance(r.distanceM)} · ~{fmtDuration(r.durationS * 1000)}
        </span>
      ) : null}
      <div className="row">
        <button className="btn small" onClick={onUndo} disabled={!plan.points.length}>
          Son noktayı sil
        </button>
        <button className="btn small" onClick={onClear} disabled={!plan.points.length}>
          Temizle
        </button>
        <button className="btn small primary" onClick={onSave} disabled={!r || plan.busy} title="Planı kütüphaneye kayıt olarak ekle (GPX olarak dışa aktarılabilir, gerçek kayıtla karşılaştırılabilir)">
          Kaydet
        </button>
      </div>
      <small className="muted">Yol bilgisi: OpenStreetMap (FOSSGIS yönlendirme servisi); internet gerekir.</small>
    </div>
  );
}
