import { Component, type ReactNode } from "react";
import { PREFS_KEY } from "../prefs";

/** Arayüzde beklenmeyen bir hata pencereyi beyaz bırakmasın: hata gösterilir,
 * yeniden yükleme ya da görünüm tercihlerini sıfırlama önerilir. Kütüphane,
 * etiketler ve ayarlar arka uçta durduğu için sıfırlama onlara dokunmaz. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h2>Bir şeyler ters gitti</h2>
        <p>Arayüzde beklenmeyen bir hata oluştu. Kayıtlarınız, etiketleriniz ve ayarlarınız güvende.</p>
        <pre>{String(error.message || error)}</pre>
        <div className="crash-actions">
          <button className="btn primary" onClick={() => location.reload()}>
            Yeniden yükle
          </button>
          <button
            className="btn"
            onClick={() => {
              try {
                localStorage.removeItem(PREFS_KEY);
              } catch {
                /* önemli değil */
              }
              location.reload();
            }}
          >
            Görünüm tercihlerini sıfırla
          </button>
        </div>
      </div>
    );
  }
}
