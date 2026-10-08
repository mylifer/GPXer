import { expect, test } from "./app";
import { COMMUTES } from "./fixtures";

test("Özet: yaşam dönemleri; döneme tıklayınca liste süzülür", async ({ app, mock }) => {
  const DAY = 86_400_000;
  const base = COMMUTES[0];
  const t0 = Date.parse("2024-03-01T06:00:00Z");
  // Mart–Mayıs 2024 her gün Kadıköy'den başlayan kayıtlar.
  const list = Array.from({ length: 80 }, (_, i) => {
    const shift = t0 + i * DAY - base.stats.startTime!;
    return {
      ...base,
      path: `/kutuphane/gun-${i}.gpx`,
      fileName: `gun-${i}.gpx`,
      name: `Gün ${i}`,
      startPlace: "Kadıköy",
      stats: { ...base.stats, startTime: base.stats.startTime! + shift, endTime: base.stats.endTime! + shift },
      times: base.times.map((l) => l.map((t) => (t == null ? t : t + shift))),
      visits: [],
      hours: [],
    };
  });
  const byPath = new Map(list.map((s) => [s.path, s]));
  mock.library_files = () => list.map((s) => s.path);
  mock.load_files = (a) => (a.paths as string[]).map((p) => ({ status: "ok", file: byPath.get(p) }));
  await app.reload();
  await app.locator(".file-row").first().waitFor({ state: "attached" });
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  const lp = app.getByTestId("life-periods");
  await expect(lp.locator("li")).toHaveCount(1);
  await expect(lp).toContainText("Mart 2024 – Mayıs 2024");
  await expect(lp).toContainText("Kadıköy");
  await expect(lp).toContainText("3 ay");
  await lp.getByRole("button").click();
  await expect(app.locator(".file-row")).not.toHaveCount(0);
});
