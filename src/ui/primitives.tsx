import type { ReactNode } from "react";
import { ActionIcon, Button, Tooltip } from "@mantine/core";
import { isModern } from "./mode";

/** İki görünümde de kullanılan düğme. Klasikte ilk tasarımdaki `.btn`
 * (önünde emoji), Modernde simgeli Mantine düğmesi. */
export function Btn({
  icon,
  emoji,
  primary,
  active,
  danger,
  title,
  onClick,
  disabled,
  children,
}: {
  icon?: ReactNode;
  emoji?: string;
  primary?: boolean;
  /** Açık/kapalı düğmede açık hali. */
  active?: boolean;
  danger?: boolean;
  title?: string;
  onClick(): void;
  disabled?: boolean;
  children: string;
}) {
  if (!isModern)
    return (
      <button
        className={`btn small${primary || active ? " primary" : ""}${danger ? " danger" : ""}`}
        onClick={onClick}
        disabled={disabled}
        title={title}
      >
        {emoji ? `${emoji} ${children}` : children}
      </button>
    );
  const b = (
    <Button
      size="compact-sm"
      variant={primary ? "filled" : active ? "light" : "default"}
      color={danger ? "red" : undefined}
      leftSection={icon}
      onClick={onClick}
      disabled={disabled}
      fw={500}
    >
      {children}
    </Button>
  );
  return title ? (
    <Tooltip label={title}>
      <span style={{ display: "inline-flex" }}>{b}</span>
    </Tooltip>
  ) : (
    b
  );
}

/** Yalnızca simgeli düğme. Klasikte `.icon-btn` içinde karakter (`glyph`). */
export function IconBtn({ icon, glyph, label, onClick, disabled }: { icon: ReactNode; glyph: string; label: string; onClick(): void; disabled?: boolean }) {
  if (!isModern)
    return (
      <button className="icon-btn" onClick={onClick} title={label} aria-label={label} disabled={disabled}>
        {glyph}
      </button>
    );
  return (
    <Tooltip label={label}>
      <ActionIcon size={28} onClick={onClick} aria-label={label} disabled={disabled}>
        {icon}
      </ActionIcon>
    </Tooltip>
  );
}
