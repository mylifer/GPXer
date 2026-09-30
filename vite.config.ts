import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri geliştirme sunucusu sabit portta çalışmalı.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: { target: "es2021", chunkSizeWarningLimit: 2000 },
});
