import { describe, expect, it } from "vitest";
import { EN, EN_T } from "./en";

describe("English dictionary", () => {
  it("has non-empty translations and matching placeholders", () => {
    for (const [k, v] of Object.entries(EN)) {
      expect(v.trim(), k).not.toBe("");
    }
    for (const [tr, en] of EN_T) {
      const a = (tr.match(/\{\d+\}/g) ?? []).sort();
      const b = (en.match(/\{\d+\}/g) ?? []).sort();
      expect(b, tr).toEqual(a);
    }
  });
});
