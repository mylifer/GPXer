import { useEffect, useMemo, useRef, useState } from "react";
import { TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { searchPlacesOffline, searchPlacesOnline, type Bookmark, type NamedPlace, type PlaceHit } from "../api";
import { isModern } from "../ui/mode";
import { LOCALE, searchKey as foldText } from "../format";

const regionNames = (() => {
  try {
    return new Intl.DisplayNames([LOCALE], { type: "region" });
  } catch {
    return null;
  }
})();
/** Çevrimdışı sonuçta "il, ülke kodu" → "il, ülke adı". */
const withCountry = (h: PlaceHit): PlaceHit => {
  if (h.kind !== "city") return h;
  const parts = h.detail.split(", ");
  const cc = parts.pop() ?? "";
  const country = (cc && regionNames?.of(cc)) || cc;
  return { ...h, detail: [...parts, country].filter(Boolean).join(", ") };
};

/** Sonucun yakınlaştırma düzeyi: türüne göre. */
function zoomFor(kind: string): number {
  if (["country"].includes(kind)) return 5;
  if (["state", "region", "province"].includes(kind)) return 7;
  if (["city", "town", "county", "municipality"].includes(kind)) return 11;
  if (["village", "suburb", "district", "neighbourhood", "hamlet"].includes(kind)) return 13;
  return 16;
}

interface Row {
  hit: PlaceHit;
  group: string;
}

/** Haritada yer arama: yer imleri, adlandırılmış yerler, çevrimdışı yerleşimler ve çevrimiçi adresler. */
export function MapSearch({
  places,
  bookmarks,
  prefer,
  center,
  onShow,
}: {
  places: NamedPlace[];
  bookmarks: Bookmark[];
  /** Öne alınacak ülke kodları (gezilen ülkeler). */
  prefer: string[];
  center(): [number, number] | null;
  onShow(hit: PlaceHit, zoom: number): void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [offline, setOffline] = useState<PlaceHit[]>([]);
  const [online, setOnline] = useState<PlaceHit[]>([]);
  const [onlineState, setOnlineState] = useState<"idle" | "busy" | "error">("idle");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // Ctrl/⌘+F: arama kutusuna geç.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        if (document.querySelector(".modal-backdrop, .palette")) return;
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const query = q.trim();
  // Yazdıkça çevrimdışı; biraz durunca çevrimiçi arama.
  useEffect(() => {
    if (query.length < 2) {
      setOffline([]);
      setOnline([]);
      setOnlineState("idle");
      return;
    }
    let live = true;
    searchPlacesOffline(query, prefer)
      .then((r) => live && setOffline((r ?? []).map(withCountry)))
      .catch(() => live && setOffline([]));
    if (query.length < 3) return () => void (live = false);
    setOnlineState("busy");
    const t = setTimeout(() => {
      const c = center();
      searchPlacesOnline(query, c?.[1] ?? null, c?.[0] ?? null)
        .then((r) => {
          if (!live) return;
          setOnline(r ?? []);
          setOnlineState("idle");
        })
        .catch(() => {
          if (!live) return;
          setOnline([]);
          setOnlineState("error");
        });
    }, 450);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, prefer, center]);

  const rows = useMemo<Row[]>(() => {
    if (query.length < 2) return [];
    const f = foldText(query);
    const mine: Row[] = [
      ...places
        .filter((p) => foldText(p.name).includes(f))
        .map((p) => ({ group: "Adlandırılmış yerler", hit: { name: p.name, detail: "", lat: p.lat, lon: p.lon, bbox: null, kind: "place" } })),
      ...bookmarks
        .filter((b) => foldText(`${b.name} ${b.note}`).includes(f))
        .map((b) => ({ group: "Yer imleri", hit: { name: `${b.wish ? "⭐" : "📌"} ${b.name}`, detail: b.note, lat: b.lat, lon: b.lon, bbox: null, kind: "place" } })),
    ].slice(0, 6);
    const near = (a: PlaceHit, b: PlaceHit) => Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.02 && foldText(a.name) === foldText(b.name);
    const off = offline.map((hit) => ({ group: "Yerleşim yerleri", hit }));
    // Çevrimiçi sonuçlardan, çevrimdışı listede zaten olanlar atlanır.
    const on = online.filter((h) => !offline.some((o) => near(o, h))).map((hit) => ({ group: "Çevrimiçi (OpenStreetMap)", hit }));
    return [...mine, ...off, ...on];
  }, [query, places, bookmarks, offline, online]);

  useEffect(() => setActive(0), [query]);

  const pick = (r: Row) => {
    onShow(r.hit, zoomFor(r.hit.kind));
    setOpen(false);
    input.current?.blur();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter" && rows[active]) {
      e.preventDefault();
      pick(rows[active]);
    } else if (e.key === "Escape") {
      // Arama kutusundaki Esc yalnızca listeyi kapatır.
      e.stopPropagation();
      e.preventDefault();
      if (open) setOpen(false);
      else {
        setQ("");
        input.current?.blur();
      }
    }
  };

  const placeholder = "Haritada ara… (Ctrl/⌘+F)";
  const field = isModern ? (
    <TextInput
      ref={input}
      size="xs"
      radius="md"
      leftSection={<IconSearch size={14} />}
      placeholder={placeholder}
      value={q}
      onChange={(e) => {
        setQ(e.currentTarget.value);
        setOpen(true);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
      aria-label="Haritada ara"
    />
  ) : (
    <input
      ref={input}
      type="search"
      placeholder={placeholder}
      value={q}
      onChange={(e) => {
        setQ(e.target.value);
        setOpen(true);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={onKeyDown}
      aria-label="Haritada ara"
    />
  );
  let lastGroup = "";
  return (
    <div className="map-search" ref={box}>
      {field}
      {open && query.length >= 2 && (
        <ul className="map-search-results" role="listbox">
          {rows.map((r, i) => {
            const head = r.group !== lastGroup;
            lastGroup = r.group;
            return [
              head && (
                <li key={`g${r.group}`} className="hit-group" role="presentation">
                  {r.group}
                </li>
              ),
              <li
                key={`${r.group}${i}`}
                className={i === active ? "active" : ""}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
              >
                <span data-no-i18n>{r.hit.name}</span>
                {r.hit.detail && (
                  <span className="hit-detail" data-no-i18n>
                    {r.hit.detail}
                  </span>
                )}
              </li>,
            ];
          })}
          {onlineState === "busy" && <li className="hit-note">Çevrimiçi aranıyor…</li>}
          {onlineState === "error" && <li className="hit-note">Çevrimiçi arama yapılamadı (internet yok); yalnızca çevrimdışı sonuçlar.</li>}
          {rows.length === 0 && onlineState !== "busy" && <li className="hit-note">Sonuç yok.</li>}
        </ul>
      )}
    </div>
  );
}
