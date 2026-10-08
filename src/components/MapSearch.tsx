import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ActionIcon, TextInput, Tooltip } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { searchPlacesOffline, searchPlacesOnline, searchStreetsOffline, searchTrace, streetsInfo, type Bookmark, type NamedPlace, type PlaceHit } from "../api";
import { isModern } from "../ui/mode";
import { t } from "../i18n";
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
  if (["village", "suburb", "district", "neighbourhood", "quarter", "hamlet"].includes(kind)) return 13;
  if (kind === "peak") return 14;
  if (kind.startsWith("poi:")) return 17;
  return 16;
}

/** OpenStreetMap yol türleri (çevrimiçi sonuçlarda "Cadde/sokak" diye gösterilir). */
const ROAD = new Set([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "residential",
  "unclassified",
  "living_street",
  "service",
  "pedestrian",
  "road",
  "street",
]);
/** Sonuç türünün okunur adı (yoksa null). */
function kindLabel(kind: string): string | null {
  if (ROAD.has(kind)) return "Cadde/sokak";
  if (kind === "path" || kind === "footway" || kind === "track") return "Patika";
  if (kind === "suburb" || kind === "district") return "Semt";
  if (kind === "quarter" || kind === "neighbourhood") return "Mahalle";
  if (kind === "village") return "Köy";
  if (kind === "hamlet" || kind === "isolated_dwelling") return "Mezra";
  if (kind === "island" || kind === "islet") return "Ada";
  if (kind === "peak") return "Zirve";
  if (kind.startsWith("poi:")) return kind.slice(4).replace(/_/g, " ");
  return null;
}
/** Türün adı ayrıntının başına (çevrilerek). */
const withKind = (h: PlaceHit): PlaceHit => {
  const label = kindLabel(h.kind);
  return label ? { ...h, kind: ROAD.has(h.kind) ? "street" : h.kind, detail: [t(label), h.detail].filter(Boolean).join(" · ") } : h;
};
/** Sorgu bir yol adına benziyor mu (sokak sonuçları önce gelsin). */
const STREETY = /(^|\s)(cad\S*|cd\.?|sok\S*|sk\.?|bulv\S*|blv\.?|yolu|street|st\.|road|rd\.?|avenue|ave\.?)(\s|$)/i;

interface Row {
  hit: PlaceHit;
  group: string;
}

/** Aksansız, küçük harf (eşleşme gücü için: "kas" ≈ "Kaş"). */
const fold = (s: string) =>
  s
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^[📌⭐]\s*/u, "")
    .trim();
/** Türkçe adres kısaltmaları ("cd" → "caddesi"); arka uçtaki açılımla aynı. */
const ABBR: Record<string, string> = {
  cd: "caddesi",
  cad: "caddesi",
  cadd: "caddesi",
  sk: "sokak",
  sok: "sokak",
  blv: "bulvari",
  bulv: "bulvari",
  bul: "bulvari",
  mh: "mahallesi",
  mah: "mahallesi",
};
const expand = (q: string) =>
  q
    .split(/\s+/)
    .map((w) => ABBR[w.replace(/\.$/, "")] ?? w)
    .join(" ");
/** Sonuç adının sorguya uyumu: 0 tam, 1 baştan, 2 bütün kelimeler adın ya da
 * adresin kelime başlarında ("fırın sokak erenköy" → Fırın Sokak · Erenköy), 3 diğer.
 * `q` katlanmış sorgu. */
function strength(name: string, q: string, detail = ""): number {
  const n = fold(name);
  const e = expand(q);
  if (n === q || n === e) return 0;
  if (n.startsWith(q) || n.startsWith(e)) return 1;
  const words = fold(`${name} ${detail}`).split(/[\s,'’.·-]+/);
  if (e.split(" ").every((w) => words.some((k) => k.startsWith(w) || (w.startsWith("sokak") && k.startsWith("soka"))))) return 2;
  return 3;
}

/** Bir sorgu için gelen sonuç (eski sorgunun sonucu yenisininkiyle karışmasın). */
interface Got {
  q: string;
  hits: PlaceHit[];
}

/** Haritada yer arama: araç çubuğunda bir düğme; tıklayınca (ya da Ctrl/⌘+F)
 * altında arama kutusu açılır. Yer imleri, adlandırılmış yerler, çevrimdışı
 * yerleşimler ve sokaklar, çevrimiçi adresler. */
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
  const [offline, setOffline] = useState<Got>({ q: "", hits: [] });
  const [streets, setStreets] = useState<Got>({ q: "", hits: [] });
  const [online, setOnline] = useState<Got>({ q: "", hits: [] });
  const [onlineState, setOnlineState] = useState<"idle" | "busy" | "error">("idle");
  const [active, setActive] = useState(0);
  /** Tanılama açık mı; açıksa son çevrimiçi aramanın adımları ve sokak dizini. */
  const [diag, setDiag] = useState(false);
  const [trace, setTrace] = useState<[string, string[]] | null>(null);
  const [index, setIndex] = useState<[number, number] | null>(null);
  /** Enter'a sonuçlar gelmeden basıldı: gelince ilk sonuç seçilir. */
  const [waiting, setWaiting] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const show = () => {
    setOpen(true);
    // Panel zaten açıksa hemen; değilse çizilir çizilmez (aşağıda) odaklanır.
    input.current?.focus();
    input.current?.select();
  };
  // Panel açılınca kutu aynı karede odaklanır: Ctrl/⌘+F'nin hemen ardından
  // yazılan harfler kaybolmaz.
  useLayoutEffect(() => {
    if (!open) return;
    input.current?.focus();
    input.current?.select();
  }, [open]);
  // Ctrl/⌘+F: aramayı aç.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        if (document.querySelector(".modal-backdrop, .palette")) return;
        e.preventDefault();
        show();
      }
    };
    // Komut paletinden.
    const onOpen = () => show();
    window.addEventListener("keydown", onKey);
    window.addEventListener("gpxer:open-search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("gpxer:open-search", onOpen);
    };
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
    setWaiting(false);
    if (query.length < 2) {
      setOnlineState("idle");
      return;
    }
    let live = true;
    searchPlacesOffline(query, prefer)
      .then((r) => live && setOffline({ q: query, hits: (r ?? []).map(withCountry) }))
      .catch(() => live && setOffline({ q: query, hits: [] }));
    {
      const c = center();
      searchStreetsOffline(query, c?.[1] ?? null, c?.[0] ?? null)
        .then((r) => live && setStreets({ q: query, hits: (r ?? []).map(withKind) }))
        .catch(() => live && setStreets({ q: query, hits: [] }));
    }
    if (query.length < 3) {
      setOnlineState("idle");
      return () => void (live = false);
    }
    setOnlineState("busy");
    const timer = setTimeout(() => {
      const c = center();
      searchPlacesOnline(query, c?.[1] ?? null, c?.[0] ?? null)
        .then((r) => {
          if (!live) return;
          setOnline({ q: query, hits: (r ?? []).map(withKind) });
          setOnlineState("idle");
        })
        .catch(() => {
          if (!live) return;
          setOnline({ q: query, hits: [] });
          setOnlineState("error");
        });
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, prefer, center]);

  // Tanılama: çevrimiçi arama bitince adımları al.
  useEffect(() => {
    if (!diag || !open) return;
    let live = true;
    streetsInfo()
      .then((r) => live && setIndex(r))
      .catch(() => {});
    if (onlineState !== "busy")
      searchTrace()
        .then((r) => live && setTrace(r))
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [diag, open, onlineState, query]);

  /** Çevrimdışı sonuçlar henüz bu sorgu için gelmedi. */
  const pending = query.length >= 2 && (offline.q !== query || streets.q !== query);

  const rows = useMemo<Row[]>(() => {
    if (query.length < 2) return [];
    const f = foldText(query);
    const fq = fold(query);
    const mine: Row[] = [
      ...places
        .filter((p) => foldText(p.name).includes(f))
        .map((p) => ({ group: "Adlandırılmış yerler", hit: { name: p.name, detail: "", lat: p.lat, lon: p.lon, bbox: null, kind: "place" } })),
      ...bookmarks
        .filter((b) => foldText(`${b.name} ${b.note}`).includes(f))
        .map((b) => ({
          group: "Yer imleri",
          hit: { name: `${b.wish ? "⭐" : "📌"} ${b.name}`, detail: b.note, lat: b.lat, lon: b.lon, bbox: null, kind: "place" },
        })),
    ].slice(0, 6);
    // Eski sorgunun sonuçları yenisi gelene kadar gösterilir, ama yalnızca hâlâ uyuyorsa.
    const fits = (g: Got) => (g.q === query ? g.hits : g.q && fq.startsWith(fold(g.q)) ? g.hits.filter((h) => strength(h.name, fq, h.detail) < 3) : []);
    const offHits = fits(offline);
    const strHits = fits(streets);
    const onHits = online.q === query ? online.hits : [];
    const near = (a: PlaceHit, b: PlaceHit) => Math.abs(a.lat - b.lat) < 0.02 && Math.abs(a.lon - b.lon) < 0.02 && foldText(a.name) === foldText(b.name);
    // Aynı cadde çevrimdışı ve çevrimiçi aynı yerde: bir kez (yakınlık caddede daha gevşek).
    const close = (a: PlaceHit, b: PlaceHit) => Math.abs(a.lat - b.lat) < 0.05 && Math.abs(a.lon - b.lon) < 0.05 && foldText(a.name) === foldText(b.name);
    const groups: Row[][] = [
      mine,
      offHits.map((hit) => ({ group: "Yerleşim yerleri", hit })),
      strHits.map((hit) => ({ group: "Sokak ve yerler (çevrimdışı)", hit })),
      // Çevrimiçi sonuçlardan, çevrimdışı listelerde zaten olanlar atlanır.
      onHits.filter((h) => !offHits.some((o) => near(o, h)) && !strHits.some((o) => close(o, h))).map((hit) => ({ group: "Çevrimiçi (OpenStreetMap)", hit })),
    ];
    // Sorguya en iyi uyan sonucu olan grup öne (ör. çevrimdışında yalnızca
    // benzer adlar varken çevrimiçinde tam eşleşme). Eşitlikte olağan sıra;
    // sokak adına benzeyen sorguda sokaklar yerleşimlerden önce.
    const order = STREETY.test(query) ? [0, 2, 1, 3] : [0, 1, 2, 3];
    const best = (g: Row[]) => Math.min(4, ...g.map((r) => strength(r.hit.name, fq, r.hit.detail)));
    return order
      .map((i) => ({ i, rows: groups[i], best: best(groups[i]) }))
      .filter((g) => g.rows.length)
      .sort((a, b) => a.best - b.best || order.indexOf(a.i) - order.indexOf(b.i))
      .flatMap((g) => g.rows);
  }, [query, places, bookmarks, offline, streets, online]);

  useEffect(() => setActive(0), [query]);

  const pick = (r: Row) => {
    onShow(r.hit, zoomFor(r.hit.kind));
    setOpen(false);
    setWaiting(false);
  };
  /** Enter için ilk sonuç yeterince iyi mi (yoksa çevrimiçi sonuç beklenir). */
  const settled = !pending && (onlineState !== "busy" || (rows[0] != null && strength(rows[0].hit.name, fold(query), rows[0].hit.detail) <= 1));
  useEffect(() => {
    if (!waiting || !settled) return;
    setWaiting(false);
    if (rows[0]) pick(rows[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, settled, rows]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Okla seçilmiş sonuç hemen; yoksa bu sorgunun sonuçları gelince ilki.
      if (active > 0 && rows[active]) pick(rows[active]);
      else if (settled && rows[0]) pick(rows[0]);
      else if (query.length >= 2) setWaiting(true);
    } else if (e.key === "Escape") {
      // Arama kutusundaki Esc yalnızca aramayı kapatır.
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
    }
  };

  /** Tanılama satırları: her kaynağın bu sorgu için ne döndürdüğü. */
  const diagLines = (): string[] => {
    const count = (g: Got) =>
      g.q === query
        ? `${g.hits.length} sonuç${
            g.hits.length
              ? ` (${g.hits
                  .slice(0, 3)
                  .map((h) => h.name)
                  .join(", ")})`
              : ""
          }`
        : "aranıyor…";
    const out = [
      `Çevrimdışı yerleşim listesi: ${count(offline)}`,
      `Çevrimdışı sokak dizini: ${count(streets)}${index ? ` · dizinde ${index[0]} ad, ${index[1]} karo` : ""}`,
    ];
    if (index && index[0] === 0)
      out.push("  Sokak dizini boş: Sade ya da Koyu haritada bölgeyi yakınlaştırarak gezin ya da Katmanlar → çevrimdışı için indirin.");
    if (query.length < 3) out.push("Çevrimiçi: en az 3 harf gerekir");
    else if (onlineState === "busy") out.push("Çevrimiçi: aranıyor…");
    else if (trace && trace[0] === query) out.push(...trace[1].map((l) => `Çevrimiçi · ${l}`));
    else if (onlineState === "error") out.push("Çevrimiçi: arama yapılamadı (internet yok ya da servis yanıt vermedi)");
    else out.push("Çevrimiçi: bu sorgu için kayıt yok");
    return out;
  };

  const placeholder = "Yer, adres ya da sokak ara…";
  const onChange = (v: string) => setQ(v);
  const field = isModern ? (
    <TextInput
      ref={input}
      size="sm"
      radius="md"
      leftSection={<IconSearch size={15} />}
      placeholder={placeholder}
      value={q}
      onChange={(e) => onChange(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      aria-label="Haritada ara"
    />
  ) : (
    <input
      ref={input}
      type="search"
      placeholder={placeholder}
      value={q}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      aria-label="Haritada ara"
    />
  );
  const trigger = isModern ? (
    <Tooltip label="Haritada ara (Ctrl/⌘+F)" disabled={open}>
      <ActionIcon
        size={30}
        variant={open ? "light" : "subtle"}
        color={open ? undefined : "gray"}
        onClick={() => (open ? setOpen(false) : show())}
        aria-label="Haritada ara (Ctrl/⌘+F)"
      >
        <IconSearch size={18} />
      </ActionIcon>
    </Tooltip>
  ) : (
    <button className={`btn small${open ? " primary" : ""}`} onClick={() => (open ? setOpen(false) : show())} title="Haritada ara (Ctrl/⌘+F)">
      🔍 Ara
    </button>
  );
  let lastGroup = "";
  return (
    <div className="map-search" ref={box}>
      {trigger}
      {open && (
        <div className="map-search-panel">
          {field}
          {query.length >= 2 && (
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
              {(onlineState === "busy" || pending) && <li className="hit-note">{waiting ? "Aranıyor; sonuç gelince gidilecek…" : "Çevrimiçi aranıyor…"}</li>}
              {onlineState === "error" && <li className="hit-note">Çevrimiçi arama yapılamadı (internet yok); yalnızca çevrimdışı sonuçlar.</li>}
              {rows.length === 0 && onlineState !== "busy" && !pending && <li className="hit-note">Sonuç yok.</li>}
            </ul>
          )}
          {query.length < 2 && <div className="hit-note map-search-hint">Şehir, semt, cadde, mekân ya da adres yazın; Enter ilk sonuca gider.</div>}
          {query.length >= 2 && (
            <div className="map-search-foot">
              <button className="link-btn" onClick={() => setDiag((d) => !d)} aria-expanded={diag}>
                {diag ? "Tanılamayı gizle" : "Aradığınız çıkmadı mı? Tanılama"}
              </button>
            </div>
          )}
          {diag && query.length >= 2 && (
            <Diagnostics
              lines={diagLines()}
              onStreets={() => {
                setOpen(false);
                window.dispatchEvent(new Event("gpxer:open-streets"));
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Arama tanılaması: satırlar ve panoya kopyalama (hata bildirirken yapıştırmak için). */
function Diagnostics({ lines, onStreets }: { lines: string[]; onStreets(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="map-search-diag">
      <pre data-no-i18n>{lines.join("\n")}</pre>
      <button
        className="link-btn"
        onClick={() =>
          navigator.clipboard
            ?.writeText(lines.join("\n"))
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? "Kopyalandı" : "Kopyala"}
      </button>{" "}
      ·{" "}
      <button className="link-btn" onClick={onStreets}>
        Bir bölgenin sokaklarını çevrimdışı aramaya ekle…
      </button>
    </div>
  );
}
