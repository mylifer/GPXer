/** Arayüz dili. Türkçe asıl dil; İngilizce seçilince arayüzdeki metinler
 * sözlükten çevrilir (DOM'daki metin düğümleri ve title/placeholder gibi
 * öznitelikler), tuval ve dosya içerikleri `t()` ile. Kullanıcı içeriği
 * (kayıt adları, notlar) sözlükte olmadığı için değişmez. */
import { EN, EN_T } from "./en";

export type Lang = "tr" | "en";
export const LANG_KEY = "gpxer.lang";

function readLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === "en" ? "en" : "tr";
  } catch {
    return "tr";
  }
}

export const lang: Lang = readLang();

/** Dili kaydeder; uygulama yeniden yüklenince geçerli olur. */
export function saveLang(l: Lang) {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    // tarayıcı deposu yoksa dil Türkçe kalır
  }
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const templates = EN_T.map(([tr, en]) => {
  const order: number[] = [];
  const src = norm(tr)
    .split(/(\{\d+\})/)
    .map((part) => {
      const m = /^\{(\d+)\}$/.exec(part);
      if (!m) return esc(part);
      order.push(Number(m[1]));
      return "([\\s\\S]+?)";
    })
    .join("");
  // Yer tutucusuz metin uzunluğu: özel kalıp ("{0}. gün") genelden ("{0} gün") önce denensin.
  const literal = norm(tr).replace(/\{\d+\}/g, "").length;
  return { re: new RegExp(`^${src}$`), order, en, literal };
}).sort((a, b) => b.literal - a.literal);

const cache = new Map<string, string | null>();

/** Metnin İngilizcesi (yoksa null). */
function lookup(text: string): string | null {
  const key = norm(text);
  if (!key || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(key)) return null;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out: string | null = EN[key] ?? null;
  if (out == null) {
    for (const t of templates) {
      const m = t.re.exec(key);
      if (!m) continue;
      const vals: string[] = [];
      t.order.forEach((n, i) => (vals[n] = m[i + 1]));
      // Değerler de çevrilebilir (ör. "Altlık: Uydu").
      out = t.en.replace(/\{(\d+)\}/g, (_, n) => {
        const v = vals[Number(n)] ?? "";
        return v.trim() ? t_(v) : v;
      });
      break;
    }
  }
  // Yan yana parçalar: baştaki bağlaç ya da ayraçla birlikte gelen metin.
  if (out == null) {
    const w = /^(· |, |; |— |\()(.+?)(\)?)$/.exec(key);
    if (w && (w[1] !== "(" || w[3])) {
      const inner = lookup(w[2]);
      if (inner != null) out = `${w[1]}${inner}${w[3]}`;
    }
  }
  if (cache.size > 20_000) cache.clear();
  cache.set(key, out);
  return out;
}

/** Programla üretilen metinler (tuval, dosya, sistem pencereleri) için. */
export function t(s: string): string {
  if (lang === "tr") return s;
  return t_(s);
}

function t_(s: string): string {
  const r = lookup(s);
  if (r == null) return s;
  // Baştaki/sondaki boşluklar korunur (yan yana metin parçaları).
  const lead = /^\s*/.exec(s)![0];
  const trail = /\s*$/.exec(s)![0];
  return lead + r + trail;
}

const ATTRS = ["title", "placeholder", "aria-label", "alt"];
const SKIP = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "CODE"]);

function translateNode(n: Node) {
  if (n.nodeType === Node.TEXT_NODE) {
    const p = n.parentElement;
    if (!p || SKIP.has(p.tagName) || p.isContentEditable || p.closest("[data-no-i18n]")) return;
    const v = n.nodeValue ?? "";
    const r = t(v);
    if (r !== v) n.nodeValue = r;
    return;
  }
  if (n.nodeType !== Node.ELEMENT_NODE) return;
  const el = n as Element;
  if (SKIP.has(el.tagName) && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return;
  // Kullanıcı metni (kayıt, yer, etiket adları) çevrilmez.
  if (el.closest("[data-no-i18n]")) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v) {
      const r = t(v);
      if (r !== v) el.setAttribute(a, r);
    }
  }
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
  for (const c of Array.from(el.childNodes)) translateNode(c);
}

/** İngilizcede DOM'u izleyip çevirir; Türkçede hiçbir şey yapmaz. */
export function installDomTranslation(root: HTMLElement = document.documentElement) {
  if (lang === "tr") return;
  document.documentElement.lang = "en";
  translateNode(root);
  const obs = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") translateNode(m.target);
      else if (m.type === "attributes") translateNode(m.target);
      else m.addedNodes.forEach(translateNode);
    }
  });
  obs.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
