import { afterEach, describe, expect, it } from "vitest";
import type { NamedPlace } from "./api";
import { namedPlaceAt, setNamedPlaces } from "./places";

// 41° enleminde 0,001° boylam ≈ 84 m, 0,001° enlem ≈ 111 m.
const place = (id: string, lon: number, lat: number, radiusM = 150): NamedPlace => ({ id, name: id, lon, lat, radiusM });

afterEach(() => setNamedPlaces([]));

describe("namedPlaceAt", () => {
  it("yarıçap içindeki noktayı eşler", () => {
    const ev = place("ev", 29, 41);
    expect(namedPlaceAt(29.001, 41, [ev])?.id).toBe("ev");
    expect(namedPlaceAt(29, 41.001, [ev])?.id).toBe("ev");
    expect(namedPlaceAt(29, 41.002, [ev])).toBeNull();
    expect(namedPlaceAt(29.002, 41, [ev])).toBeNull();
  });

  it("yarıçap yere göre", () => {
    expect(namedPlaceAt(29, 41.002, [place("büyük", 29, 41, 300)])?.id).toBe("büyük");
  });

  it("birden çok yer kapsıyorsa en yakını", () => {
    const list = [place("a", 29, 41), place("b", 29.0015, 41)];
    expect(namedPlaceAt(29.0004, 41, list)?.id).toBe("a");
    expect(namedPlaceAt(29.0011, 41, list)?.id).toBe("b");
  });

  it("liste verilmezse güncel liste kullanılır", () => {
    expect(namedPlaceAt(29, 41)).toBeNull();
    setNamedPlaces([place("iş", 29, 41)]);
    expect(namedPlaceAt(29, 41)?.name).toBe("iş");
  });
});
