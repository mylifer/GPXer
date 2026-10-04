import { useEffect, useRef, useState, type ReactNode } from "react";

export interface LayerItem {
  id: string;
  label: ReactNode;
  title: string;
  on: boolean;
  toggle(): void;
}

/** Harita araç çubuğunda ek katmanlar (açılır liste; araç çubuğu kalabalıklaşmasın). */
export function LayersMenu({ items, actions = [] }: { items: LayerItem[]; actions?: { label: string; title: string; run(): void }[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const active = items.filter((i) => i.on).length;
  return (
    <div className="photo-control" ref={box}>
      <button
        className={`btn small${active ? " primary" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Ek harita katmanları"
      >
        Katmanlar{active ? ` (${active})` : ""} ▾
      </button>
      {open && (
        <div className="menu-pop layers-pop" role="menu">
          {items.map((i) => (
            <label key={i.id} className="check" title={i.title}>
              <input type="checkbox" checked={i.on} onChange={i.toggle} />
              {i.label}
            </label>
          ))}
          {actions.map((a) => (
            <button
              key={a.label}
              className="btn small"
              title={a.title}
              onClick={() => {
                setOpen(false);
                a.run();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
