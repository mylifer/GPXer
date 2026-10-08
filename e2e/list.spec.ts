import { expect, test } from "./app";

test("kayıtlar listelenir ve aylara göre gruplanır", async ({ app }) => {
  await expect(app.locator(".file-row")).toHaveCount(7);
  await expect(app.locator(".group-head").first()).toBeVisible();
});

test.describe("çok kayıt", () => {
  test.use({ records: 120 });

  for (const classic of [false, true]) {
    test(`kaydırınca üstteki grup başlığı kayıtların üzerine binmez${classic ? " (klasik)" : ""}`, async ({ app }) => {
      const list = app.locator(".file-list");
      await list.evaluate((el) => (el.scrollTop = 900));
      const head = app.locator(".sticky-head .group-head");
      await expect(head).toBeVisible();
      // Arka plan saydam olmamalı (altından kayıtlar görünmesin).
      const bg = await head.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toMatch(/rgba\(.*,\s*0\)|transparent/);
      // Başlık sanal listedeki yerinden (30 px) taşmamalı.
      const box = (await head.boundingBox())!;
      expect(Math.round(box.height)).toBeLessThanOrEqual(30);
    });
  }
});
