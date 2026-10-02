import { useEffect, useRef, useState } from "react";
import { fmtNumber } from "../format";

const OFFSETS = Array.from({ length: 27 }, (_, i) => i - 13);

/** Harita araç çubuğunda fotoğraf katmanı: aç/kapat, ekle, saat düzeltmesi. */
export function PhotoControl(p: {
  count: number;
  unplaced: number;
  on: boolean;
  offset: number;
  onToggle(): void;
  onOffset(h: number): void;
  onAdd(folder: boolean): void;
  onClear(): void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menu]);
  const has = p.count > 0 || p.unplaced > 0;
  return (
    <div className="photo-control" ref={box}>
      {has && (
        <button
          className={`btn small${p.on ? " primary" : ""}`}
          onClick={p.onToggle}
          title={`Fotoğrafları haritada göster/gizle · ${fmtNumber(p.count)} haritada${
            p.unplaced ? `, ${fmtNumber(p.unplaced)} tanesinin konumu yok ya da o saatte kayıt yok` : ""
          }`}
        >
          Fotoğraflar ({fmtNumber(p.count)})
        </button>
      )}
      <button
        className="btn small"
        onClick={() => setMenu((v) => !v)}
        aria-expanded={menu}
        title="Fotoğraf ekle: konum bilgisi olmayanlar çekim zamanına göre iz üzerine yerleştirilir (fotoğrafları haritaya sürükleyip bırakabilirsiniz)"
      >
        📷 Fotoğraf ekle ▾
      </button>
      {has && p.on && (
        <label className="map-select" title="Fotoğraf makinesinin saati yanlışsa düzeltme (saat): çekim zamanına eklenir">
          <select value={p.offset} onChange={(e) => p.onOffset(Number(e.target.value))}>
            {OFFSETS.map((h) => (
              <option key={h} value={h}>
                Saat {h > 0 ? `+${h}` : h === 0 ? "±0" : h} sa
              </option>
            ))}
          </select>
        </label>
      )}
      {menu && (
        <div className="menu-pop" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              p.onAdd(false);
            }}
          >
            Fotoğraf dosyaları…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenu(false);
              p.onAdd(true);
            }}
          >
            Klasör…
          </button>
          {has && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenu(false);
                p.onClear();
              }}
            >
              Tüm fotoğrafları kaldır
            </button>
          )}
        </div>
      )}
    </div>
  );
}
