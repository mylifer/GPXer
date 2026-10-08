export interface Gap {
  /** İlk ve son kayıtsız gün (dahil). */
  from: string;
  to: string;
  days: number;
}

export interface Coverage {
  /** Yıl → 12 ay için [kayıtlı gün, aydaki gün sayısı]. */
  years: [number, [number, number][]][];
  /** İlk ve son kayıt arasındaki uzun boşluklar, en uzunu önce. */
  gaps: Gap[];
  recorded: number;
  /** İlk kayıttan son kayda kadar geçen gün sayısı. */
  span: number;
}

const DAY = 86_400_000;
const utc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const isoUtc = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Kayıtlı günlerden (YYYY-AA-GG) yıl/ay doluluğu ve `minGap` günden uzun
 * kayıtsız dönemler. Kapsam ilk kaydın yılından son kaydın yılına kadardır. */
export function coverage(days: Iterable<string>, minGap = 14): Coverage {
  const set = [...new Set(days)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!set.length) return { years: [], gaps: [], recorded: 0, span: 0 };
  const first = Number(set[0].slice(0, 4));
  const last = Number(set[set.length - 1].slice(0, 4));
  const years: Coverage["years"] = [];
  for (let y = last; y >= first; y--) {
    const months: [number, number][] = Array.from({ length: 12 }, (_, m) => [0, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()]);
    years.push([y, months]);
  }
  for (const d of set) {
    const y = Number(d.slice(0, 4));
    years[last - y][1][Number(d.slice(5, 7)) - 1][0]++;
  }
  const gaps: Gap[] = [];
  for (let i = 1; i < set.length; i++) {
    const n = Math.round((utc(set[i]) - utc(set[i - 1])) / DAY) - 1;
    if (n >= minGap) gaps.push({ from: isoUtc(utc(set[i - 1]) + DAY), to: isoUtc(utc(set[i]) - DAY), days: n });
  }
  gaps.sort((a, b) => b.days - a.days || (a.from < b.from ? -1 : 1));
  return { years, gaps, recorded: set.length, span: Math.round((utc(set[set.length - 1]) - utc(set[0])) / DAY) + 1 };
}
