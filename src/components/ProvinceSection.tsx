import { useRegions } from "../hooks/useRegions";
import { fmtNumber, isoToTr } from "../format";
import { PROVINCE_COUNT } from "../regions";
import type { FileEntry } from "../types";

/** Özet'te gezilen Türkiye illeri: ilk giriş tarihi sırasıyla. */
export function ProvinceSection({ files, from, to }: { files: FileEntry[]; from: string; to: string }) {
  const r = useRegions(files, from, to, true);
  if (!r) return null;
  const v = r.provinceVisits;
  return (
    <>
      <h3 className="chart-title">
        Gezilen iller: {fmtNumber(v.length)} / {PROVINCE_COUNT}
      </h3>
      {v.length === 0 ? (
        <div className="muted small-note">Gösterilen kayıtlarda Türkiye'de geçilen il yok.</div>
      ) : (
        <>
          <div className="province-bar" aria-hidden>
            <div style={{ width: `${(v.length / PROVINCE_COUNT) * 100}%` }} />
          </div>
          <div className="visited-countries">
            {v.map((p) => (
              <span
                key={p.name}
                className="chip"
                title={`${p.name}: ilk giriş ${p.first ? isoToTr(p.first) : "tarihsiz"} · ${fmtNumber(p.records)} kayıt`}
              >
                {p.name}
                {p.first && <span className="muted"> · {p.first.slice(0, 4)}</span>}
              </span>
            ))}
          </div>
          <p className="muted small-note">
            Haritada görmek için: Katmanlar ▾ → Gezilen il ve ülkeler. İl sınırları © OpenStreetMap katkıcıları.
          </p>
        </>
      )}
    </>
  );
}
