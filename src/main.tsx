import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";
import { installDomTranslation, lang } from "./i18n";
import { invoke } from "@tauri-apps/api/core";

// İngilizce arayüz: metinler çizildikçe çevrilir; uygulama menüsü de İngilizce kurulur.
installDomTranslation();
if (lang === "en" && "__TAURI_INTERNALS__" in window) invoke("set_menu_language", { lang }).catch(() => {});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
