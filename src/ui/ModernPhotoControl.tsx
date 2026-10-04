import { ActionIcon, Badge, Button, Menu, NativeSelect, Tooltip } from "@mantine/core";
import { IconChevronDown, IconFolder, IconPhoto, IconPhotoPlus, IconRoute, IconTrash } from "@tabler/icons-react";
import { fmtNumber } from "../format";
import type { PhotoControl } from "../components/PhotoControl";

type Props = Parameters<typeof PhotoControl>[0];

const OFFSETS = Array.from({ length: 27 }, (_, i) => i - 13);

/** Modern görünümde fotoğraf katmanı: aç/kapat, ekle, saat düzeltmesi, iz oluşturma. */
export function ModernPhotoControl(p: Props) {
  const has = p.count > 0 || p.unplaced > 0;
  return (
    <>
      {has && (
        <Tooltip
          label={`Fotoğrafları haritada göster/gizle · ${fmtNumber(p.count)} haritada${
            p.unplaced ? `, ${fmtNumber(p.unplaced)} tanesinin konumu yok ya da o saatte kayıt yok` : ""
          }`}
        >
          <Button
            size="compact-sm"
            variant={p.on ? "light" : "subtle"}
            color={p.on ? undefined : "gray"}
            leftSection={<IconPhoto size={16} />}
            onClick={p.onToggle}
          >
            Fotoğraflar
            <Badge size="xs" circle ml={6} variant={p.on ? "filled" : "default"}>
              {fmtNumber(p.count)}
            </Badge>
          </Button>
        </Tooltip>
      )}
      {has && p.on && (
        <Tooltip label="Fotoğraf makinesinin saati yanlışsa düzeltme (saat): çekim zamanına eklenir">
          <NativeSelect
            size="xs"
            w={110}
            aria-label="Saat düzeltmesi"
            value={String(p.offset)}
            onChange={(e) => p.onOffset(Number(e.currentTarget.value))}
            data={OFFSETS.map((h) => ({ value: String(h), label: `Saat ${h > 0 ? `+${h}` : h === 0 ? "±0" : h} sa` }))}
          />
        </Tooltip>
      )}
      <Menu shadow="md" width={250} position="bottom-start">
        <Menu.Target>
          {has ? (
            <ActionIcon size={30} aria-label="Fotoğraf ekle">
              <IconPhotoPlus size={18} />
            </ActionIcon>
          ) : (
            <Button size="compact-sm" variant="subtle" color="gray" leftSection={<IconPhotoPlus size={16} />} rightSection={<IconChevronDown size={14} />}>
              Fotoğraf ekle
            </Button>
          )}
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Konumsuz fotoğraflar çekim zamanına göre iz üzerine yerleşir</Menu.Label>
          <Menu.Item leftSection={<IconPhotoPlus size={16} />} onClick={() => p.onAdd(false)}>
            Fotoğraf dosyaları…
          </Menu.Item>
          <Menu.Item leftSection={<IconFolder size={16} />} onClick={() => p.onAdd(true)}>
            Klasör…
          </Menu.Item>
          {has && (
            <>
              <Menu.Divider />
              <Menu.Item leftSection={<IconRoute size={16} />} onClick={p.onTrack}>
                Fotoğraflardan iz oluştur
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={p.onClear}>
                Tüm fotoğrafları kaldır
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </>
  );
}
