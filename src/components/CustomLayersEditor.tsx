import { useState } from "react";
import { validLayerUrl, type CustomLayer } from "../customLayers";

/** Ayarlar'da harita katmanı ekleme/silme (XYZ ya da WMS adresi). */
export function CustomLayersEditor({ layers, onChange }: { layers: CustomLayer[]; onChange(l: CustomLayer[]): void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = () => {
    const e = validLayerUrl(url);
    if (e) return setErr(e);
    onChange([
      ...layers,
      { id: `k${Date.now().toString(36)}`, name: name.trim() || `Katman ${layers.length + 1}`, url: url.trim(), on: true, opacity: 0.8 },
    ]);
    setName("");
    setUrl("");
    setErr(null);
  };
  return (
    <>
      {layers.length > 0 && (
        <ul className="folder-list">
          {layers.map((l) => (
            <li key={l.id}>
              <strong>{l.name}</strong>
              <span title={l.url}>{l.url}</span>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={l.opacity}
                title="Saydamlık"
                aria-label={`${l.name} saydamlığı`}
                onChange={(e) => onChange(layers.map((x) => (x.id === l.id ? { ...x, opacity: e.target.valueAsNumber } : x)))}
              />
              <button className="icon-btn tiny" onClick={() => onChange(layers.filter((x) => x.id !== l.id))} aria-label={`${l.name} katmanını kaldır`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="field-row">
        <label className="field">
          <span>Ad</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ör. Eski haritalar" />
        </label>
        <label className="field" style={{ gridColumn: "span 2" }}>
          <span>Adres (XYZ ya da WMS)</span>
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setErr(null);
            }}
            placeholder="https://…/{z}/{x}/{y}.png"
          />
        </label>
      </div>
      {err && <div className="error small-note">{err}</div>}
      <div>
        <button className="btn small" onClick={add} disabled={!url.trim()}>
          Katman ekle
        </button>
      </div>
    </>
  );
}
