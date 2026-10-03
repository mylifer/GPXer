import { defineConfig } from "vitest/config";

// Testler bilgisayarın saat diliminden bağımsız olsun: saat dilimi verilmeyen
// çağrılar (tz kipi "local") her makinede aynı sonucu versin.
process.env.TZ = "UTC";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env: { TZ: "UTC" },
  },
});
