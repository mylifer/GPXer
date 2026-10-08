import { useEffect, useMemo, useRef, useState } from "react";
import { indexStreetTiles, streetsInfo } from "../api";
import { fmtNumber } from "../format";
import { loadProvinces, type ProvinceFC } from "../regions";
import { MAX_TILES, TILE_KB, tilesInBox, tilesInPolygon } from "../streetTiles";
import { Modal } from "./Modal";

const CHUNK = 100;

/** Bir ilin ya da görünen alanın sokak, semt ve mekân adlarını indirip
 * çevrimdışı aramaya ekler (harita da o bölgede çevrimdışı açılır). */
export function StreetsDialog({ bounds, onClose, onDone }: { bounds(): [number, number, number, number] | null; onClose(): void; onDone(msg: string): void }) {
  const [provinces, setProvinces] = useState<ProvinceFC | null>(null);
  const [target, setTarget] = useState("view");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<[number, number] | null>(null);
  const cancel = useRef(false);
  const [view] = useState(bounds);

  useEffect(() => {
    loadProvinces()
      .then(setProvinces)
      .catch(() => {});
    streetsInfo()
      .then(setInfo)
      .catch(() => {});
  }, []);

  const names = useMemo(() => (provinces ? provinces.features.map((f) => f.properties.name).sort((a, b) => a.localeCompare(b, "tr")) : []), [provinces]);
  const tiles = useMemo(() => {
    if (target === "view") return view ? tilesInBox(view) : [];
    const f = provinces?.features.find((x) => x.properties.name === target);
    return f ? tilesInPolygon(f.geometry.coordinates) : [];
  }, [target, view, provinces]);
  const tooMany = tiles.length > MAX_TILES;

  const start = async () => {
    cancel.current = false;
    setError(null);
    setProgress({ done: 0, total: tiles.length });
    let total = info?.[0] ?? 0;
    try {
      for (let i = 0; i < tiles.length; i += CHUNK) {
        if (cancel.current) break;
        [, total] = await indexStreetTiles(tiles.slice(i, i + CHUNK));
        setProgress({ done: Math.min(tiles.length, i + CHUNK), total: tiles.length });
      }
      const where = target === "view" ? "Görünen alan" : target;
      onDone(
        cancel.current
          ? `${where}: indirme durduruldu; aramada ${fmtNumber(total)} sokak ve yer var.`
          : `${where} aramaya eklendi: aramada ${fmtNumber(total)} sokak ve yer var.`,
      );
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  };

  const running = progress != null;
  return (
    <Modal title="Sokakları çevrimdışı aramaya ekle" onClose={() => (running ? (cancel.current = true) : onClose())}>
      <div className="form">
        <label className="field">
          <span>Bölge</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={running} aria-label="Bölge">
            <option value="view">Haritada görünen alan</option>
            {names.map((n) => (
              <option key={n} value={n} data-no-i18n>
                {n}
              </option>
            ))}
          </select>
        </label>
        <small>
          Bölgedeki bütün cadde, sokak, semt, mahalle ve mekân adları indirilir; internet yokken de aranabilir. Aynı karolar haritanın o bölgede çevrimdışı
          açılmasını da sağlar. Yurtdışı için haritayı o bölgeye getirip “Haritada görünen alan”ı seçin.
        </small>
        <div className="hint" data-testid="streets-estimate">
          {tiles.length
            ? `${fmtNumber(tiles.length)} karo · yaklaşık ${fmtNumber(Math.max(1, Math.round((tiles.length * TILE_KB) / 1024)))} MB (önceden indirilenler atlanır)`
            : "Bölge seçin."}
          {tooMany && ` — en çok ${fmtNumber(MAX_TILES)} karo; daha küçük bir bölge seçin.`}
        </div>
        {info && <small>Şu an aramada {fmtNumber(info[0])} sokak ve yer var.</small>}
        {running && (
          <div className="streets-progress">
            <progress max={progress.total} value={progress.done} />
            <span>
              {fmtNumber(progress.done)} / {fmtNumber(progress.total)}
            </span>
          </div>
        )}
        {error && <div className="hint error">İndirilemedi: {error}</div>}
        <div className="form-actions">
          {running ? (
            <button type="button" className="btn" onClick={() => (cancel.current = true)}>
              Durdur
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>
                Vazgeç
              </button>
              <button type="button" className="btn primary" disabled={!tiles.length || tooMany} onClick={start}>
                İndir
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
