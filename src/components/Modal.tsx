import { useEffect, useRef, useState, type ReactNode } from "react";

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} title="Kapat (Esc)">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Tek satırlık metin soran pencere (WebView'larda window.prompt güvenilir değil). */
export function PromptModal({
  title,
  label,
  initial,
  okLabel,
  onOk,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  okLabel: string;
  onOk(v: string): void;
  onClose(): void;
}) {
  const [v, setV] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) onOk(v.trim());
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input ref={input} value={v} onChange={(e) => setV(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn" onClick={onClose}>
            Vazgeç
          </button>
          <button type="submit" className="btn primary" disabled={!v.trim()}>
            {okLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}
