import { useState } from "react";
import { Modal } from "./Modal";

export interface PasswordAsk {
  title: string;
  message: string;
  /** Yeni parola: iki kez yazdırılır ve boş bırakılabilir (şifresiz). */
  create: boolean;
  error?: string;
  resolve(pw: string | null): void;
}

/** Yedek parolası: yedek alırken isteğe bağlı belirlenir, geri yüklerken sorulur. */
export function PasswordModal({ ask, onDone }: { ask: PasswordAsk; onDone(): void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const mismatch = ask.create && pw !== pw2;
  const finish = (v: string | null) => {
    onDone();
    ask.resolve(v);
  };
  return (
    <Modal title={ask.title} onClose={() => finish(null)}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch && (ask.create || pw)) finish(pw);
        }}
      >
        <p className="small-note">{ask.message}</p>
        {ask.error && <div className="error small-note">{ask.error}</div>}
        <label className="field">
          <span>Parola</span>
          <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
        </label>
        {ask.create && (
          <label className="field">
            <span>Parola (tekrar)</span>
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </label>
        )}
        {mismatch && pw2 && <div className="error small-note">Parolalar aynı değil.</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={() => finish(null)}>
            Vazgeç
          </button>
          <button type="submit" className="btn primary" disabled={mismatch || (!ask.create && !pw)}>
            {ask.create && !pw ? "Şifresiz yedekle" : "Tamam"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
