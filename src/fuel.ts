import { fmtDecimal, fmtNumber } from "./format";

export type FuelKind = "benzin" | "dizel" | "lpg" | "elektrik";

export interface FuelPrefs {
  kind: FuelKind;
  /** 100 km'de tüketim (L ya da elektrikte kWh). */
  per100: number;
  /** Birim fiyat (₺/L ya da ₺/kWh). */
  price: number;
}

export const DEFAULT_FUEL: FuelPrefs = { kind: "benzin", per100: 7, price: 45 };

export const FUEL_KINDS: { id: FuelKind; label: string; unit: string; co2: number }[] = [
  // Yanmada açığa çıkan CO₂ (kg/birim); elektrikte Türkiye şebekesinin ortalaması.
  { id: "benzin", label: "Benzin", unit: "L", co2: 2.31 },
  { id: "dizel", label: "Dizel", unit: "L", co2: 2.68 },
  { id: "lpg", label: "LPG", unit: "L", co2: 1.51 },
  { id: "elektrik", label: "Elektrik", unit: "kWh", co2: 0.44 },
];

export interface FuelUse {
  amount: number;
  unit: string;
  cost: number;
  co2Kg: number;
}

/** Mesafeye göre tahmini yakıt, maliyet ve CO₂. */
export function fuelFor(distanceM: number, f: FuelPrefs): FuelUse {
  const k = FUEL_KINDS.find((x) => x.id === f.kind) ?? FUEL_KINDS[0];
  const amount = (distanceM / 100_000) * Math.max(0, f.per100);
  return { amount, unit: k.unit, cost: amount * Math.max(0, f.price), co2Kg: amount * k.co2 };
}

export const fmtMoney = (v: number) => `${fmtNumber(Math.round(v))} ₺`;
export const fmtFuel = (u: FuelUse) => `${fmtDecimal(u.amount, u.amount < 100 ? 1 : 0)} ${u.unit}`;
export const fmtCo2 = (kg: number) => (kg >= 1000 ? `${fmtDecimal(kg / 1000, 1)} t CO₂` : `${fmtNumber(Math.round(kg))} kg CO₂`);

export function isFuelPrefs(v: unknown): v is FuelPrefs {
  const o = v as FuelPrefs;
  return (
    !!o &&
    typeof o === "object" &&
    FUEL_KINDS.some((k) => k.id === o.kind) &&
    Number.isFinite(o.per100) &&
    Number.isFinite(o.price)
  );
}
