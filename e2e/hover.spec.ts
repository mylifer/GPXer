import { expect, test } from "./app";

test("iz üzerinde gezerken kutuda sokak ve mahalle/ilçe yazar", async ({ app, mock }) => {
  test.setTimeout(120_000);
  const asked: number[][] = [];
  mock.street_at = (a) => {
    asked.push([a.lon as number, a.lat as number]);
    return { street: "Fırın Sokak", area: "Erenköy, Kadıköy" };
  };
  // Kayda yakınlaşılır; iz ekranı boydan boya geçer.
  await app.locator(".file-row").first().dblclick();
  await app.waitForTimeout(1500);
  const box = (await app.locator(".maplibregl-canvas").boundingBox())!;
  const popup = app.locator(".hover-popup");
  // İzi bulana kadar ekranı tara.
  let found = false;
  // İz ekranın ortasından geçer: ortadan dışa doğru yatay satırlar.
  const mid = box.y + box.height / 2;
  for (const dy of [0, 30, -30, 60, -60, 90, -90, 120, -120])
    for (let x = box.x + 40; x < box.x + box.width - 40 && !found; x += 5) {
      await app.mouse.move(x, mid + dy);
      found = await popup.isVisible();
    }
  expect(found, "iz üzerinde kutu açılmadı").toBe(true);
  await expect(popup.locator(".popup-street")).toHaveText("📍 Fırın Sokak · Erenköy, Kadıköy");
  expect(asked.length).toBeGreaterThan(0);
});
