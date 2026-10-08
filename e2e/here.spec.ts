import { expect, test } from "./app";

test("haritada sağ tık → burada ne zaman bulundum", async ({ app, mock }) => {
  mock.street_at = () => ({ street: "D-100", area: "Kartepe" });
  // İzmit yakınından geçen kayda yakınlaşılır, iz üzerinde sağ tıklanır.
  await app.locator(".file-row", { hasText: "İstanbul → Ankara" }).first().dblclick();
  await app.waitForTimeout(1500);
  const box = (await app.locator(".maplibregl-canvas").boundingBox())!;
  const popup = app.locator(".hover-popup");
  let pt: [number, number] | null = null;
  const mid = box.y + box.height / 2;
  for (const dy of [0, 30, -30, 60, -60, 90, -90])
    for (let x = box.x + 40; x < box.x + box.width - 40 && !pt; x += 5) {
      await app.mouse.move(x, mid + dy);
      if (await popup.isVisible()) pt = [x, mid + dy];
    }
  expect(pt).not.toBeNull();
  await app.mouse.click(pt![0], pt![1], { button: "right" });
  await app.getByRole("menuitem", { name: /Burada ne zaman bulundum/ }).click();
  await expect(app.getByText("D-100 · Kartepe")).toBeVisible();
  await expect(app.getByTestId("here-summary")).toContainText("1 geçiş · 1 kayıt");
  await app.locator(".here-list button").first().click();
  await expect(app.locator(".file-row.selected")).toContainText("İstanbul → Ankara");
});
