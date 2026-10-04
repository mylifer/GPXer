import { memo, useMemo } from "react";
import { ActionIcon, Badge, Button, Checkbox, CloseButton, Group, Progress, Select, TextInput, Tooltip } from "@mantine/core";
import {
  IconArrowsDiff,
  IconCalendarEvent,
  IconCopy,
  IconDownload,
  IconEye,
  IconEyeOff,
  IconFileSpreadsheet,
  IconFilterOff,
  IconGitMerge,
  IconHistory,
  IconMarquee2,
  IconSearch,
  IconTag,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { ACTIVITIES } from "../types";
import { filtersActive, resetFilters, type Filters, type GroupBy, type SortKey } from "../prefs";
import { fmtDistance, fmtDuration, fmtElevation, fmtNumber } from "../format";
import { dedupedTotals } from "../days";
import { t } from "../i18n";
import { DateRange } from "../components/DateRange";
import { FileList } from "../components/FileList";
import type { SidebarProps } from "../components/Sidebar";

/** Modern görünümde kayıt listesi: arama, filtreler, liste ve toplamlar. */
export const ModernSidebar = memo(function ModernSidebar(p: SidebarProps) {
  const totals = useMemo(() => {
    const vis = p.shown.filter((f) => f.visible).map((f) => f.summary);
    const tt = dedupedTotals(vis, p.filters.from, p.filters.to);
    return { dist: tt.distanceM, moving: tt.movingMs, gain: tt.gainM, visible: vis.length };
  }, [p.shown, p.filters.from, p.filters.to, p.tzMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const allVisible = p.shown.length > 0 && p.shown.every((f) => f.visible);
  const set = (patch: Partial<Filters>) => p.onFilters({ ...p.filters, ...patch });
  const filtered = p.shown.length !== p.files.length;
  const anyFilter = filtersActive(p.filters);
  const hiddenCount = p.shown.length - totals.visible;
  const multi = [...p.multi];
  const showMultiHint = !p.multiHintSeen && !!p.selected && multi.length <= 1 && p.shown.length > 1;
  // Seçim kutularının görünen değeri <input> içinde: çeviri burada yapılır.
  const opt = (value: string, label: string) => ({ value, label: t(label) });

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <h1>Kayıtlar</h1>
        {p.files.length > 0 && (
          <Badge variant="light" size="sm" radius="sm">
            {filtered ? `${fmtNumber(p.shown.length)} / ${fmtNumber(p.files.length)}` : fmtNumber(p.files.length)}
          </Badge>
        )}
        <span className="spacer" />
        {anyFilter && (
          <Tooltip label="Filtreleri sıfırla">
            <ActionIcon size="sm" onClick={() => p.onFilters(resetFilters(p.filters))} aria-label="Filtreleri sıfırla">
              <IconFilterOff size={16} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>

      {p.loading && (
        <div style={{ padding: "0 12px 8px" }} aria-live="polite">
          <Progress value={(p.loading.done / Math.max(1, p.loading.total)) * 100} size="sm" animated />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
            Yükleniyor… {fmtNumber(p.loading.done)} / {fmtNumber(p.loading.total)}
          </div>
        </div>
      )}

      {p.files.length === 0 && !p.loading && (
        <div className="empty-hint" style={{ padding: "8px 14px" }}>
          <p className="muted">Kayıtları açmak için dosyaları pencereye bırakın ya da soldaki düğmelerle dosya veya klasör seçin.</p>
          <Group gap={6}>
            <Button size="xs" onClick={p.onOpenFiles}>
              Dosya Aç
            </Button>
            <Button size="xs" variant="default" onClick={p.onOpenFolder}>
              Klasör Aç
            </Button>
          </Group>
        </div>
      )}

      {p.files.length > 0 && (
        <div className="filters">
          <TextInput
            size="xs"
            placeholder="Ad, yer, etiket ya da notta ara…"
            leftSection={<IconSearch size={14} />}
            value={p.filters.query}
            onChange={(e) => set({ query: e.currentTarget.value })}
            rightSection={p.filters.query ? <CloseButton size="xs" onClick={() => set({ query: "" })} aria-label="Aramayı temizle" /> : null}
          />
          <DateRange from={p.filters.from} to={p.filters.to} years={p.years} onChange={(from, to) => set({ from, to })} />
          {(p.filters.from || p.filters.to) && (
            <Checkbox
              size="xs"
              label="Tarihsiz kayıtları da göster"
              checked={p.filters.includeUndated}
              onChange={(e) => set({ includeUndated: e.currentTarget.checked })}
            />
          )}
          <Group gap={6} grow wrap="nowrap">
            <Select
              size="xs"
              aria-label="Etkinlik türüne göre filtrele"
              allowDeselect={false}
              value={p.filters.activity}
              onChange={(v) => set({ activity: v ?? "" })}
              data={[opt("", "Tüm türler"), ...ACTIVITIES.map((a) => ({ value: a.id, label: `${a.icon} ${t(a.label)}` }))]}
            />
            <Select
              size="xs"
              aria-label="Etikete göre filtrele"
              allowDeselect={false}
              disabled={!p.allTags.length}
              value={p.filters.tag}
              onChange={(v) => set({ tag: v ?? "" })}
              data={[opt("", p.allTags.length ? "Tüm etiketler" : "Etiket yok"), ...p.allTags.map((x) => ({ value: x, label: x }))]}
            />
          </Group>
          <Group gap={6}>
            <Tooltip label="Haritada sürükleyerek bir alan çizin; yalnızca oradan geçen kayıtlar listelenir">
              <Button
                size="compact-xs"
                variant={p.areaMode ? "filled" : "light"}
                leftSection={<IconMarquee2 size={14} />}
                onClick={() => p.onAreaMode(!p.areaMode)}
              >
                Alan seç
              </Button>
            </Tooltip>
            <Tooltip
              label={
                p.overlaps.size
                  ? "Yalnızca zamanı başka bir kayıtla en az 30 dakika çakışan kayıtları göster (ör. aynı anda iki cihazla kaydedilenler)"
                  : "Zamanı çakışan kayıt yok"
              }
            >
              <Button
                size="compact-xs"
                variant={p.filters.overlap ? "filled" : "light"}
                leftSection={<IconArrowsDiff size={14} />}
                disabled={!p.overlaps.size && !p.filters.overlap}
                onClick={() => set({ overlap: !p.filters.overlap })}
              >
                Çakışanlar{p.overlaps.size ? ` (${fmtNumber(p.overlaps.size)})` : ""}
              </Button>
            </Tooltip>
            {p.duplicateGroups > 0 && (
              <Tooltip label="Aynı yolculuğun farklı adla ya da biraz farklı kesilmiş kopyaları: hangisi tutulsun?">
                <Button size="compact-xs" variant="light" color="orange" leftSection={<IconCopy size={14} />} onClick={p.onDuplicates}>
                  Kopyalar ({fmtNumber(p.duplicateGroups)})
                </Button>
              </Tooltip>
            )}
            <Tooltip label="Ne zaman neredeydim? Bir tarih ve saat girin; o anı kapsayan kayda gidilir (G)">
              <Button size="compact-xs" variant="light" color="gray" leftSection={<IconHistory size={14} />} onClick={p.onGoTo}>
                Tarihe git
              </Button>
            </Tooltip>
            <Tooltip label="Bir günün akışı: nerede durulmuş, nereden nereye gidilmiş">
              <Button size="compact-xs" variant="light" color="gray" leftSection={<IconCalendarEvent size={14} />} onClick={p.onDay}>
                Gün akışı
              </Button>
            </Tooltip>
          </Group>
          {(p.filters.area || p.filters.route) && (
            <Group gap={6}>
              {p.filters.area && (
                <Badge variant="light" rightSection={<CloseButton size="xs" onClick={() => set({ area: null })} aria-label="Alan filtresini kaldır" />}>
                  Seçilen alandan geçenler
                </Badge>
              )}
              {p.filters.route && (
                <Badge variant="light" rightSection={<CloseButton size="xs" onClick={() => set({ route: null })} aria-label="Güzergâh filtresini kaldır" />}>
                  Güzergâh: {p.routeLabel ?? "seçili"}
                </Badge>
              )}
            </Group>
          )}
          {p.areaMode && <div className="hint">Haritada sürükleyerek bir alan çizin (Esc: vazgeç).</div>}
          <Group gap={6} wrap="nowrap">
            <Checkbox size="xs" label="Tümü" checked={allVisible} onChange={() => p.onToggleAll(!allVisible)} />
            <Select
              size="xs"
              aria-label="Sıralama"
              allowDeselect={false}
              value={p.filters.sort}
              onChange={(v) => v && set({ sort: v as SortKey })}
              data={[opt("date-desc", "Yeni → eski"), opt("date-asc", "Eski → yeni"), opt("name", "Ad"), opt("distance", "Mesafe")]}
              style={{ flex: 1 }}
            />
            <Select
              size="xs"
              aria-label="Gruplama"
              allowDeselect={false}
              value={p.groupBy}
              onChange={(v) => v && p.onGroupBy(v as GroupBy)}
              data={[opt("month", "Aya göre"), opt("year", "Yıla göre"), opt("none", "Gruplama yok")]}
              style={{ flex: 1 }}
            />
          </Group>
        </div>
      )}

      {multi.length > 1 && (
        <div className="multi-bar">
          <Group justify="space-between">
            <strong>{multi.length} kayıt seçili</strong>
            <CloseButton size="sm" onClick={p.onClearMulti} aria-label="Seçimi temizle" />
          </Group>
          <Group gap={4}>
            {multi.length === 2 && (
              <Button size="compact-xs" leftSection={<IconArrowsDiff size={14} />} onClick={p.onCompare}>
                Karşılaştır
              </Button>
            )}
            <Button size="compact-xs" variant="default" leftSection={<IconGitMerge size={14} />} onClick={p.onMerge}>
              Birleştir
            </Button>
            <Button size="compact-xs" variant="default" leftSection={<IconTag size={14} />} onClick={p.onTagMany}>
              Etiketle
            </Button>
            <Button size="compact-xs" variant="default" leftSection={<IconFileSpreadsheet size={14} />} onClick={p.onExportCsv}>
              CSV
            </Button>
            <Button size="compact-xs" variant="default" leftSection={<IconDownload size={14} />} onClick={p.onExportMulti}>
              Dışa aktar…
            </Button>
            <Button size="compact-xs" variant="default" leftSection={<IconEye size={14} />} onClick={() => p.onSetVisible(multi, true)}>
              Göster
            </Button>
            <Button size="compact-xs" variant="default" leftSection={<IconEyeOff size={14} />} onClick={() => p.onSetVisible(multi, false)}>
              Gizle
            </Button>
            <Button size="compact-xs" variant="light" color="red" leftSection={<IconTrash size={14} />} onClick={() => p.onRemove(multi)}>
              Kaldır
            </Button>
          </Group>
        </div>
      )}

      {showMultiHint && (
        <div className="hint multi-hint" style={{ margin: "8px 10px 0" }}>
          <span>Ctrl/⌘ ile birden çok kayıt seçip karşılaştırabilir ya da birleştirebilirsiniz.</span>
          <CloseButton size="xs" icon={<IconX size={12} />} onClick={p.onDismissMultiHint} aria-label="İpucunu kapat" />
        </div>
      )}

      <FileList {...p} />

      {p.files.length > 0 && (
        <div className="totals">
          <div className="muted" style={{ fontSize: 11.5 }}>
            <strong style={{ color: "var(--text)" }}>{fmtNumber(p.shown.length)}</strong> kayıt gösteriliyor
            {hiddenCount > 0 && <span title="Filtreye uyan ama haritada gizlenen kayıtlar toplamlara katılmaz"> · {fmtNumber(hiddenCount)} gizli</span>}
          </div>
          <div className="totals-cards">
            <div>
              <span>Mesafe</span>
              <strong>{fmtDistance(totals.dist)}</strong>
            </div>
            <div>
              <span>Hareket</span>
              <strong>{fmtDuration(totals.moving)}</strong>
            </div>
            <div>
              <span>Tırmanış</span>
              <strong>{fmtElevation(totals.gain)}</strong>
            </div>
          </div>
          <Button
            fullWidth
            size="xs"
            variant="default"
            leftSection={<IconDownload size={14} />}
            onClick={p.onExportFiltered}
            disabled={p.shown.length === 0}
            title="Listede görünen (filtreye uyan) tüm kayıtları tek dosyada dışa aktar (GPX, KML, TCX, FIT)"
          >
            {filtered ? "Filtrelenenleri dışa aktar…" : "Tümünü dışa aktar…"}
          </Button>
        </div>
      )}
    </aside>
  );
});
