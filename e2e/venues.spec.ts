import { expect, test } from "./app";
import { SUMMARIES } from "./fixtures";

test("ziyaret defteri: duraklardaki mekânlar listede ve Özet'te", async ({ app, mock }) => {
  const H = 3_600_000;
  const withStops = SUMMARIES.map((s, i) => {
    if (i !== 2) return s;
    const t = s.stats.startTime!;
    return {
      ...s,
      stops: [
        { lon: 27.6, lat: 37.0, start: t + 10 * 60_000, durationMs: H },
        { lon: 27.9, lat: 36.9, start: t + 2 * H, durationMs: 20 * 60_000 },
      ],
    };
  });
  const byPath = new Map(withStops.map((s) => [s.path, s]));
  mock.load_files = (a) => (a.paths as string[]).map((p) => ({ status: "ok", file: byPath.get(p) }));
  mock.venues_at = (a) => (a.points as [number, number][]).map(([lon]) => (lon < 27.7 ? { name: "Bitez Kahvecisi", kind: "cafe" } : null));
  await app.reload();
  const rows = app.locator(".file-row");
  await rows.first().waitFor({ state: "attached" });
  await rows.filter({ hasText: "Bodrum → Marmaris" }).click();
  await app.getByRole("button", { name: /Duraklama \(2\)/ }).click();
  await expect(app.locator(".stop-venue")).toHaveText(["☕ Bitez Kahvecisi"]);

  await app.getByRole("button", { name: /^Özet/ }).first().click();
  await app.getByRole("button", { name: "☕ 2 durak yerinde mekân ara" }).click();
  const table = app.getByTestId("venues");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await expect(table).toContainText("☕ Bitez Kahvecisi");
  await expect(table.locator("tbody td").nth(1)).toHaveText("1");
});
