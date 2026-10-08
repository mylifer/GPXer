import { expect, test } from "./app";

test("güzergâh dökümü: yollar sırayla, tıklayınca bölüm seçilir", async ({ app, mock }) => {
  mock.record_roads = () => [
    { name: "Bağdat Caddesi", small: "Erenköy", big: "Kadıköy", from: 0, to: 20, distM: 3200 },
    { name: null, small: null, big: "Ataşehir", from: 20, to: 25, distM: 400 },
    { name: "D-100", small: null, big: "Kartal", from: 25, to: 120, distM: 18000 },
  ];
  await app.locator(".file-row").first().click();
  await app.getByRole("button", { name: /Güzergâh/ }).click();
  const list = app.locator(".route-list ol li");
  await expect(list).toHaveCount(3);
  await expect(list.nth(0)).toContainText("Bağdat Caddesi · Erenköy, Kadıköy");
  await expect(list.nth(0)).toContainText("3,20 km");
  await expect(app.locator(".route-list .stat-btn strong")).toHaveText("2 yol");
  await list.nth(2).getByRole("button").click();
  // Aralık seçilince aralık araç çubuğu görünür.
  await expect(app.getByRole("button", { name: /Kırp/ })).toBeVisible();
});

test("Özet: en çok geçilen yollar ve mahalleler; eksik güzergâhlar çıkarılır", async ({ app, mock }) => {
  let ready = 3;
  const prepared: string[] = [];
  mock.road_stats = (a) => ({
    ready: Math.min(ready, (a.paths as string[]).length),
    roads: [
      ["D-100", "Kartal", 54000, 4],
      ["Bağdat Caddesi", "Kadıköy", 12000, 3],
    ],
    hoods: [
      [
        "Kadıköy",
        [
          ["Erenköy", 3],
          ["Moda", 1],
        ],
      ],
    ],
  });
  mock.prepare_roads = (a) => {
    prepared.push(...(a.paths as string[]));
    ready = 99;
    return (a.paths as string[]).length;
  };
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  await expect(app.getByText("Yollar ve mahalleler")).toBeVisible({ timeout: 15_000 });
  await expect(app.getByText("3 / 7 kaydın güzergâhı hazır.")).toBeVisible();
  await expect(app.locator(".data-table", { hasText: "D-100" })).toContainText("Kartal");
  await expect(app.locator(".hood-row")).toContainText("Erenköy");
  await app.getByRole("button", { name: "Eksikleri çıkar" }).click();
  await expect(app.getByText(/kaydın güzergâhı hazır/)).toHaveCount(0);
  expect(new Set(prepared).size).toBe(7);
});
