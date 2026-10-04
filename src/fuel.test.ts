import { describe, expect, it } from "vitest";
import { fuelFor } from "./fuel";

describe("fuelFor", () => {
  it("estimates amount, cost and CO2", () => {
    const u = fuelFor(250_000, { kind: "dizel", per100: 6, price: 50 });
    expect(u.amount).toBeCloseTo(15);
    expect(u.cost).toBeCloseTo(750);
    expect(u.co2Kg).toBeCloseTo(40.2);
    expect(fuelFor(100_000, { kind: "elektrik", per100: 18, price: 8 }).unit).toBe("kWh");
  });
});
