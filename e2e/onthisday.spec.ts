import { expect, test } from "./app";

test.use({ now: "2025-07-09T12:00:00+03:00" });

test("geçmiş yıllarda bugün: kart, göster ve kapat", async ({ app }) => {
  const card = app.locator(".otd-card");
  await expect(card).toContainText("1 yıl önce bugün");
  await expect(card).toContainText("Bodrum → Marmaris");
  await card.getByRole("button", { name: "Göster" }).click();
  await expect(app.locator(".file-row.selected")).toContainText("Bodrum → Marmaris");
  await card.getByRole("button", { name: "Kapat" }).click();
  await expect(card).toHaveCount(0);
  // Aynı gün yeniden açılınca çıkmaz.
  await app.reload();
  await app.locator(".file-row").first().waitFor({ state: "attached" });
  await expect(app.locator(".otd-card")).toHaveCount(0);
  // Özet'te yine listelenir.
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  await expect(app.locator(".otd-list")).toContainText("1 yıl önce · 09.07.2024");
});
