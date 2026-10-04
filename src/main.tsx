import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import { installDomTranslation, lang } from "./i18n";
import { invoke } from "@tauri-apps/api/core";
import { isModern, uiMode } from "./ui/mode";

// İngilizce arayüz: metinler çizildikçe çevrilir; uygulama menüsü de İngilizce kurulur.
installDomTranslation();
if (lang === "en" && "__TAURI_INTERNALS__" in window) invoke("set_menu_language", { lang }).catch(() => {});

async function start() {
  document.documentElement.dataset.ui = uiMode;
  // Modern görünümün kütüphanesi ve stilleri yalnızca o seçiliyse yüklenir.
  let Wrap = ({ children }: { children: ReactNode }) => <>{children}</>;
  if (isModern) Wrap = (await import("./ui/ModernRoot")).ModernRoot;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ErrorBoundary>
        <Wrap>
          <App />
        </Wrap>
      </ErrorBoundary>
    </StrictMode>,
  );
}
void start();
