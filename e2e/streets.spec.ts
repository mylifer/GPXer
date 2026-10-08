import { expect, test } from "./app";

test("bir ilin sokakları parça parça indirilip aramaya eklenir", async ({ app, mock }) => {
  const chunks: number[] = [];
  let names = 1000;
  mock.streets_info = () => [names, 10];
  mock.index_street_tiles = (a) => {
    const n = (a.tiles as unknown[]).length;
    chunks.push(n);
    names += n * 3;
    return [n, names];
  };
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Sokakları çevrimdışı");
  await app.keyboard.press("Enter");
  await app.getByLabel("Bölge").selectOption("İstanbul");
  const est = app.getByTestId("streets-estimate");
  await expect(est).toContainText(/karo · yaklaşık \d+ MB/);
  const tiles = Number((await est.innerText()).match(/^([\d.]+) karo/)![1].replace(/\./g, ""));
  expect(tiles).toBeGreaterThan(1000);
  await app.getByRole("button", { name: "İndir", exact: true }).click();
  await expect(app.getByText(/İstanbul aramaya eklendi/)).toBeVisible({ timeout: 30_000 });
  expect(chunks.reduce((a, b) => a + b, 0)).toBe(tiles);
  expect(Math.max(...chunks)).toBeLessThanOrEqual(100);
});

test("arama tanılamasından açılır", async ({ app }) => {
  await app.keyboard.press("Control+f");
  await app.keyboard.type("fırın sokak");
  await app.getByRole("button", { name: /Tanılama/ }).click();
  await app.getByRole("button", { name: /sokaklarını çevrimdışı aramaya ekle/ }).click();
  await expect(app.getByLabel("Bölge")).toBeVisible();
});
