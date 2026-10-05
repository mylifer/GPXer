import { useRegions } from "../hooks/useRegions";
import { fmtNumber, isoToTr } from "../format";
import { PROVINCE_COUNT, type ProvinceVisit } from "../regions";
import { countryName } from "../visits";
import type { FileEntry } from "../types";

function Chips({ visits }: { visits: ProvinceVisit[] }) {
  return (
    <div className="visited-countries" data-no-i18n>
      {visits.map((p) => (
        <span key={p.key} className="chip" title={`${p.name}: ilk giriş ${p.first ? isoToTr(p.first) : "tarihsiz"} · ${fmtNumber(p.records)} kayıt`}>
          {p.name}
          {p.first && <span className="muted"> · {p.first.slice(0, 4)}</span>}
        </span>
      ))}
    </div>
  );
}

/** Özet'te gezilen Türkiye illeri ve öteki ülkelerin bölgeleri: ilk giriş tarihi sırasıyla. */
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
          <Chips visits={v} />
        </>
      )}
      {r.abroad.length > 0 && (
        <>
          <h3 className="chart-title">Yurtdışında gezilen bölgeler</h3>
          {r.abroad.map((a) => (
            <div key={a.cc} className="abroad-regions">
              <div className="abroad-head">
                <b data-no-i18n>{countryName(a.cc)}</b>
                <span className="muted">{`${fmtNumber(a.visits.length)} / ${fmtNumber(a.total)} bölge`}</span>
              </div>
              <div className="province-bar" aria-hidden>
                <div style={{ width: `${(a.visits.length / Math.max(a.total, 1)) * 100}%` }} />
              </div>
              <Chips visits={a.visits} />
            </div>
          ))}
        </>
      )}
      {(v.length > 0 || r.abroad.length > 0) && (
        <p className="muted small-note">
          Haritada görmek için: Katmanlar ▾ → Gezilen il ve ülkeler. İl sınırları © OpenStreetMap katkıcıları; öteki ülkelerin bölgeleri Natural Earth.
        </p>
      )}
    </>
  );
}
