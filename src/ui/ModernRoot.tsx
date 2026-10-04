import "@mantine/core/styles.css";
import "@fontsource-variable/inter";
import "./modern.css";
import type { ReactNode } from "react";
import { MantineProvider, createTheme, type MantineColorsTuple } from "@mantine/core";

/** Uygulamanın yeşili (#1f6f5c) çevresinde on ton. */
const brand: MantineColorsTuple = [
  "#e8f6f1",
  "#d5ebe3",
  "#aad6c6",
  "#7cc0a8",
  "#56ad8e",
  "#3fa17e",
  "#2f9a75",
  "#1f8663",
  "#147757",
  "#006748",
];

const theme = createTheme({
  primaryColor: "brand",
  primaryShade: { light: 8, dark: 5 },
  colors: { brand },
  fontFamily: '"Inter Variable", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  defaultRadius: "md",
  cursorType: "pointer",
  fontSizes: { xs: "11px", sm: "12.5px", md: "13.5px", lg: "15px", xl: "18px" },
  components: {
    Tooltip: { defaultProps: { openDelay: 350, withArrow: true, multiline: true, maw: 320, fz: "xs" } },
    ActionIcon: { defaultProps: { variant: "subtle", color: "gray" } },
  },
});

/** Modern görünüm: Mantine sağlayıcısı ve stilleri (yalnızca bu görünümde yüklenir). */
export function ModernRoot({ children }: { children: ReactNode }) {
  return (
    <MantineProvider theme={theme} defaultColorScheme="auto">
      {children}
    </MantineProvider>
  );
}
