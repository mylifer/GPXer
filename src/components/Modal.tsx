import { useEffect, useRef, useState, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Açık pencereler yığını: Esc ve Tab yalnızca en üsttekini etkiler. */
const stack: HTMLElement[] = [];

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest("[inert]") && (el.offsetParent !== null || el === document.activeElement),
  );
}

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
  const dialog = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  // Açılıştan önce odaktaki öğe: çocuk efektleri odağı taşımadan, ilk çizimde yakalanır.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  // Odak yönetimi: açılışta içeri al, kapanışta önceki öğeye geri ver.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const prev = opener;
    stack.push(el);
    // Çocuklar (ör. PromptModal) kendi odağını efektte ayarlamış olabilir.
    if (!el.contains(document.activeElement)) {
      // Kapat düğmesi yerine ilk içerik denetimini tercih et.
      const items = focusables(el);
      const first = items.find((x) => !x.classList.contains("modal-close")) ?? items[0];
      (first ?? el).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== el) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(el);
      if (!items.length) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !el.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Yakalama aşaması: uygulamanın genel kısayolları Esc'i ayrıca işlemesin.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      const i = stack.indexOf(el);
      if (i >= 0) stack.splice(i, 1);
      if (prev && prev.isConnected && typeof prev.focus === "function") prev.focus();
    };
  }, [opener]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className={`modal${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn modal-close" onClick={onClose} title="Kapat (Esc)" aria-label="Kapat">
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
