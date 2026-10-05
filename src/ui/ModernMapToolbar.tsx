import { useLayoutEffect, useRef, type ReactNode } from "react";
import { ActionIcon, Badge, Button, Checkbox, Menu, SegmentedControl, Select, Tooltip } from "@mantine/core";
import {
  IconBookmarks,
  IconCamera,
  IconChevronDown,
  IconDownload,
  IconLineDashed,
  IconMapPinPause,
  IconPlane,
  IconRoute,
  IconSparkles,
  IconStack2,
  IconZoomScan,
} from "@tabler/icons-react";
import type { Prefs } from "../prefs";
import { fmtNumber } from "../format";
import { t } from "../i18n";
import { BASE_LAYERS } from "../map/style";
import { ModernPhotoControl } from "./ModernPhotoControl";
import type { MapToolbar } from "../components/MapToolbar";

type Props = Parameters<typeof MapToolbar>[0];

/** Açılıp kapanan harita katmanı düğmesi (simge + ipucu). */
function Toggle({ on, label, icon, onClick, disabled }: { on: boolean; label: string; icon: ReactNode; onClick(): void; disabled?: boolean }) {
  return (
    <Tooltip label={label}>
      <ActionIcon
        size={30}
        variant={on ? "light" : "subtle"}
        color={on ? "brand" : "gray"}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={on}
      >
        {icon}
      </ActionIcon>
    </Tooltip>
  );
}

/** Modern görünümde haritanın üstündeki araç çubuğu. */
export function ModernMapToolbar(p: Props) {
  const { prefs, up, files, settings } = p;
  const ref = useRef<HTMLDivElement>(null);
  // Bildirimler araç çubuğunun altında dursun (bkz. MapToolbar).
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const set = () => host.style.setProperty("--toolbar-bottom", `${el.offsetTop + el.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const has = files.length > 0;
  const layers = [
    { id: "regions", label: "Gezilen il ve ülkeler", on: prefs.regionsLayer, toggle: () => up({ regionsLayer: !prefs.regionsLayer }) },
    { id: "terrain", label: "3B arazi", on: prefs.terrain3d, toggle: () => up({ terrain3d: !prefs.terrain3d }) },
    { id: "explorer", label: "Keşif kareleri", on: prefs.explorerLayer, toggle: () => up({ explorerLayer: !prefs.explorerLayer }) },
    { id: "bookmarks", label: "Yer imleri", on: prefs.bookmarksLayer, toggle: () => up({ bookmarksLayer: !prefs.bookmarksLayer }) },
    ...prefs.customLayers.map((l) => ({
      id: l.id,
      label: l.name,
      on: l.on,
      toggle: () => up({ customLayers: prefs.customLayers.map((x) => (x.id === l.id ? { ...x, on: !x.on } : x)) }),
    })),
  ];
  const active = layers.filter((l) => l.on).length;
  const cleanTitle = settings?.stats.cleanSpikes
    ? `GPS gürültüsü temizleniyor: ${fmtNumber(files.reduce((n, f) => n + f.summary.removedPoints, 0))} GPS sıçraması ayıklandı. Orijinal dosyalar değişmez.`
    : "GPS gürültüsü temizlenmiyor; kayıtlar olduğu gibi gösteriliyor.";

  return (
    <div className="map-toolbar modern" ref={ref}>
      <div className="tool-group">
        <SegmentedControl
          size="xs"
          radius="md"
          value={p.baseLayer}
          onChange={(v) => p.setBaseLayer(v as typeof p.baseLayer)}
          data={BASE_LAYERS.map((l) => ({ value: l.id, label: t(l.label) }))}
        />
      </div>
      {!has && p.search && <div className="tool-group">{p.search}</div>}
      {has && (
        <>
          <div className="tool-group">
            <SegmentedControl
              size="xs"
              radius="md"
              value={prefs.heatmap ? "heat" : "tracks"}
              onChange={(v) => up({ heatmap: v === "heat" })}
              data={[
                { value: "tracks", label: t("İzler") },
                { value: "heat", label: t("Isı haritası") },
              ]}
            />
            <Select
              size="xs"
              w={150}
              variant="unstyled"
              aria-label="İz renkleri"
              allowDeselect={false}
              disabled={prefs.heatmap}
              value={prefs.colorMode}
              onChange={(v) => v && up({ colorMode: v as Prefs["colorMode"] })}
              data={[
                { value: "file", label: t("Renk: dosyaya göre") },
                { value: "date", label: t("Renk: tarihe göre") },
              ]}
              styles={{ input: { paddingLeft: 8 } }}
            />
          </div>
          <div className="tool-group">
            {p.search}
            <Toggle
              on={prefs.stopsLayer}
              label="Duraklamalar: tüm kayıtlarda en sık duraklama yapılan yerler"
              icon={<IconMapPinPause size={18} />}
              onClick={() => up({ stopsLayer: !prefs.stopsLayer })}
            />
            <Toggle
              on={prefs.flightsLayer}
              label={
                p.libraryFlights
                  ? `Uçuşlar: 300 km/sa üstü boşluklar yay olarak çizilir · kütüphanede ${fmtNumber(p.libraryFlights)} uçuş`
                  : "Kayıtlarda uçuş bulunamadı (300 km/sa üstü, 100 km'den uzun boşluk)"
              }
              icon={<IconPlane size={18} />}
              onClick={() => up({ flightsLayer: !prefs.flightsLayer })}
            />
            <Toggle
              on={prefs.showGaps}
              label="Boşluklar: seçili kayıtta nokta kaydedilmemiş aralıkları kesik çizgiyle göster"
              icon={<IconLineDashed size={18} />}
              onClick={() => up({ showGaps: !prefs.showGaps })}
            />
            {settings && (
              <Toggle
                on={settings.stats.cleanSpikes}
                label={cleanTitle}
                icon={<IconSparkles size={18} />}
                onClick={() => p.applySettings({ ...settings, stats: { ...settings.stats, cleanSpikes: !settings.stats.cleanSpikes } })}
              />
            )}
            <Tooltip label="Tümüne yakınlaştır (Ctrl/⌘+0)">
              <ActionIcon size={30} onClick={p.fitAll} aria-label="Tümüne yakınlaştır">
                <IconZoomScan size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Harita görüntüsünü kaydet (PNG) (Ctrl/⌘+Shift+E)">
              <ActionIcon size={30} onClick={p.exportPng} aria-label="Harita görüntüsünü kaydet">
                <IconCamera size={18} />
              </ActionIcon>
            </Tooltip>
          </div>
        </>
      )}
      <div className="tool-group">
        <Menu shadow="md" width={260} position="bottom-start" closeOnItemClick={false}>
          <Menu.Target>
            <Button
              size="compact-sm"
              variant={active ? "light" : "subtle"}
              color={active ? undefined : "gray"}
              leftSection={<IconStack2 size={16} />}
              rightSection={<IconChevronDown size={14} />}
            >
              Katmanlar
              {active > 0 && (
                <Badge size="xs" circle ml={6}>
                  {active}
                </Badge>
              )}
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>Harita katmanları</Menu.Label>
            {layers.map((l) => (
              <Menu.Item key={l.id} onClick={l.toggle} leftSection={<Checkbox size="xs" checked={l.on} readOnly tabIndex={-1} />}>
                {l.label}
              </Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Label>Araçlar</Menu.Label>
            <Menu.Item closeMenuOnClick leftSection={<IconRoute size={16} />} onClick={p.openPlan}>
              Rota planla
            </Menu.Item>
            <Menu.Item closeMenuOnClick leftSection={<IconBookmarks size={16} />} onClick={p.openBookmarks}>
              Yer imleri listesi
            </Menu.Item>
            <Menu.Item closeMenuOnClick leftSection={<IconDownload size={16} />} onClick={p.downloadArea}>
              Görünen alanı çevrimdışı için indir
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <ModernPhotoControl
          count={p.placedPhotos.placed.length}
          unplaced={p.placedPhotos.unplaced}
          on={prefs.photosLayer}
          offset={prefs.photoOffsetH}
          onToggle={() => up({ photosLayer: !prefs.photosLayer })}
          onOffset={(photoOffsetH) => up({ photoOffsetH })}
          onAdd={p.pickPhotos}
          onClear={p.clearPhotos}
          onTrack={p.photoTrack}
        />
      </div>
    </div>
  );
}
