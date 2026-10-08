import { ActionIcon, Tooltip } from "@mantine/core";
import {
  IconBookmarks,
  IconCalendarEvent,
  IconChartBar,
  IconCommand,
  IconFilePlus,
  IconFolderOpen,
  IconHelp,
  IconFilterSearch,
  IconHistory,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconRoute,
  IconSettings,
} from "@tabler/icons-react";
import type { ReactNode } from "react";

/** Modern görünümde soldaki simge çubuğu: sık kullanılan işler tek tıkla. */
export function Rail(p: {
  sidebarOpen: boolean;
  hasFiles: boolean;
  onToggleSidebar(): void;
  onOpenFiles(): void;
  onOpenFolder(): void;
  onSummary(): void;
  onDay(): void;
  onGoTo(): void;
  onSearch(): void;
  onBookmarks(): void;
  onPlan(): void;
  onPalette(): void;
  onHelp(): void;
  onSettings(): void;
}) {
  const item = (label: string, icon: ReactNode, onClick: () => void, disabled = false) => (
    <Tooltip label={label} position="right" key={label}>
      <ActionIcon size={36} radius="md" onClick={onClick} disabled={disabled} aria-label={label}>
        {icon}
      </ActionIcon>
    </Tooltip>
  );
  const s = 20;
  return (
    <nav className="rail" aria-label="Araçlar">
      <div className="rail-logo" aria-hidden>
        G
      </div>
      {item(
        p.sidebarOpen ? "Kenar çubuğunu gizle (Ctrl/⌘+B)" : "Kenar çubuğunu göster (Ctrl/⌘+B)",
        p.sidebarOpen ? <IconLayoutSidebarLeftCollapse size={s} /> : <IconLayoutSidebarLeftExpand size={s} />,
        p.onToggleSidebar,
      )}
      {item("Dosya aç (Ctrl/⌘+O)", <IconFilePlus size={s} />, p.onOpenFiles)}
      {item("Klasör aç (Ctrl/⌘+Shift+O)", <IconFolderOpen size={s} />, p.onOpenFolder)}
      {item("Özet (Ctrl/⌘+I)", <IconChartBar size={s} />, p.onSummary, !p.hasFiles)}
      {item("Gün akışı", <IconCalendarEvent size={s} />, p.onDay, !p.hasFiles)}
      {item("Tarihe git (G)", <IconHistory size={s} />, p.onGoTo, !p.hasFiles)}
      {item("Gelişmiş arama", <IconFilterSearch size={s} />, p.onSearch, !p.hasFiles)}
      {item("Yer imleri listesi", <IconBookmarks size={s} />, p.onBookmarks)}
      {item("Rota planla", <IconRoute size={s} />, p.onPlan)}
      {item("Komut paleti (Ctrl/⌘+K)", <IconCommand size={s} />, p.onPalette)}
      <div className="rail-spacer" />
      {item("Kısayollar ve yardım (?)", <IconHelp size={s} />, p.onHelp)}
      {item("Ayarlar (Ctrl/⌘+,)", <IconSettings size={s} />, p.onSettings)}
    </nav>
  );
}
