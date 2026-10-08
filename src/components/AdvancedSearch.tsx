import { useState } from "react";
import { fmtNumber } from "../format";
import { resetFilters, type Filters, type SavedSearch } from "../prefs";
import { ACTIVITIES } from "../types";
import { Modal } from "./Modal";

/** Bütün arama ölçütleri bir arada; aramayı adlandırıp saklama. */
export function AdvancedSearch({
  filters,
  allTags,
  allPeople,
  saved,
  count,
  onApply,
  onSaved,
  onClose,
}: {
  filters: Filters;
  allTags: string[];
  allPeople: string[];
  saved: SavedSearch[];
  /** Ölçütlere uyan kayıt sayısı (önizleme). */
  count(f: Filters): number;
  onApply(f: Filters): void;
  onSaved(list: SavedSearch[]): void;
  onClose(): void;
}) {
  const [f, setF] = useState<Filters>(filters);
  const [name, setName] = useState("");
  const set = (patch: Partial<Filters>) => setF((x) => ({ ...x, ...patch }));
  const num = (v: string) => Math.max(0, Number(v.replace(",", ".")) || 0);
  const n = count(f);

  return (
    <Modal title="Gelişmiş arama" onClose={onClose} wide>
      <form
        className="form adv-search"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(f);
        }}
      >
        <label className="field">
          <span>Metin (ad, yer, etiket, not)</span>
          <input value={f.query} onChange={(e) => set({ query: e.target.value })} aria-label="Metin" autoFocus />
        </label>
        <div className="adv-row">
          <label className="field">
            <span>Başlangıç</span>
            <input type="date" value={f.from} onChange={(e) => set({ from: e.target.value })} aria-label="Başlangıç tarihi" />
          </label>
          <label className="field">
            <span>Bitiş</span>
            <input type="date" value={f.to} onChange={(e) => set({ to: e.target.value })} aria-label="Bitiş tarihi" />
          </label>
          <label className="field">
            <span>Günler</span>
            <select value={f.weekday} onChange={(e) => set({ weekday: e.target.value as Filters["weekday"] })} aria-label="Günler">
              <option value="">Hepsi</option>
              <option value="weekday">Hafta içi</option>
              <option value="weekend">Hafta sonu</option>
            </select>
          </label>
        </div>
        <div className="adv-row">
          <label className="field">
            <span>Tür</span>
            <select value={f.activity} onChange={(e) => set({ activity: e.target.value })} aria-label="Tür">
              <option value="">Hepsi</option>
              {ACTIVITIES.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.icon} {a.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Etiket</span>
            <select value={f.tag} onChange={(e) => set({ tag: e.target.value })} aria-label="Etiket">
              <option value="">Hepsi</option>
              {allTags.map((t) => (
                <option key={t} value={t} data-no-i18n>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Kişi</span>
            <select value={f.person} onChange={(e) => set({ person: e.target.value })} aria-label="Kişi" disabled={!allPeople.length && !f.person}>
              <option value="">Hepsi</option>
              {allPeople.map((t) => (
                <option key={t} value={t} data-no-i18n>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="adv-row">
          <label className="field">
            <span>En az (km)</span>
            <input inputMode="decimal" value={f.minKm || ""} onChange={(e) => set({ minKm: num(e.target.value) })} aria-label="En az km" />
          </label>
          <label className="field">
            <span>En çok (km)</span>
            <input inputMode="decimal" value={f.maxKm || ""} onChange={(e) => set({ maxKm: num(e.target.value) })} aria-label="En çok km" />
          </label>
          <label className="check">
            <input type="checkbox" checked={f.overlap} onChange={(e) => set({ overlap: e.target.checked })} />
            Yalnızca zamanı çakışanlar
          </label>
        </div>
        <div className="hint" data-testid="adv-count">{`${fmtNumber(n)} kayıt uyuyor.`}</div>
        <div className="form-actions" style={{ flexWrap: "wrap" }}>
          <button type="button" className="btn" onClick={() => setF(resetFilters(f))}>
            Sıfırla
          </button>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Arama adı" aria-label="Arama adı" className="adv-name" />
          <button
            type="button"
            className="btn"
            disabled={!name.trim()}
            onClick={() => {
              const nm = name.trim();
              onSaved([...saved.filter((s) => s.name !== nm), { name: nm, filters: f }]);
              setName("");
            }}
          >
            Aramayı kaydet
          </button>
          <button type="submit" className="btn primary">
            Uygula
          </button>
        </div>
        {saved.length > 0 && (
          <fieldset>
            <legend>Kayıtlı aramalar</legend>
            <ul className="folder-list">
              {saved.map((s) => (
                <li key={s.name}>
                  <button type="button" className="link" onClick={() => onApply({ ...s.filters, sort: filters.sort })} data-no-i18n>
                    {s.name}
                  </button>
                  <span className="muted">{`${fmtNumber(count(s.filters))} kayıt`}</span>
                  <button type="button" className="icon-btn" onClick={() => onSaved(saved.filter((x) => x.name !== s.name))} aria-label="Kayıtlı aramayı sil">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
      </form>
    </Modal>
  );
}
