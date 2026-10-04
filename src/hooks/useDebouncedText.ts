import { useEffect, useRef, useState } from "react";

/** Yazı kutusu için gecikmeli değer: yazılan hemen görünür, `onCommit` yazma
 * durunca çağrılır (büyük kütüphanede her tuşta bütün listeyi süzmemek için).
 * Dışarıdan gelen değer değişirse (ör. filtreler sıfırlanınca) kutu da güncellenir. */
export function useDebouncedText(value: string, onCommit: (v: string) => void, ms = 150): [string, (v: string) => void] {
  const [text, setText] = useState(value);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text === sent.current) return;
    const t = setTimeout(() => {
      sent.current = text;
      commit.current(text);
    }, ms);
    return () => clearTimeout(t);
  }, [text, ms]);
  return [text, setText];
}
