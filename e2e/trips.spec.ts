import { expect, test } from "./app";

test.use({ commutes: true });

test("geziye göre gruplama ve gezinin kayıtlarını seçme", async ({ app }) => {
  await app.locator('input[aria-label="Gruplama"]').click();
  await app.getByRole("option", { name: "Geziye göre" }).click();
  const labels = app.locator(".file-list .group-label");
  await expect(labels.filter({ hasText: "gezisi" }).first()).toBeVisible();
  const all = await labels.allInnerTexts();
  // İstanbul'dan Ankara'ya, oradan Eskişehir'e: tek gezi; işe gidişler gezi değil.
  expect(all).toContain("Ankara gezisi · 1–3.05");
  expect(all.some((l) => /Nisan 2023/.test(l))).toBe(true);
  const head = app.locator(".file-list .group-head", { hasText: "Ankara gezisi" }).first();
  await head.getByRole("button", { name: "Seç" }).click();
  await expect(app.getByText("2 kayıt seçili")).toBeVisible();
});

test("seçilen gezinin hikâyesi tek HTML sayfası olarak kaydedilir", async ({ app, mock }) => {
  let html = "";
  mock.pick_save_path = () => "/tmp/gezi.html";
  mock.write_text_file = (a) => {
    html = a.contents as string;
    return null;
  };
  await app.locator('input[aria-label="Gruplama"]').click();
  await app.getByRole("option", { name: "Geziye göre" }).click();
  const head = app.locator(".file-list .group-head", { hasText: "Ankara gezisi" }).first();
  await head.getByRole("button", { name: "Seç" }).click();
  await app.getByRole("button", { name: "Gezi hikâyesi…" }).click();
  await expect.poll(() => html, { timeout: 20_000 }).toContain("Ankara gezisi");
  // İki kaydın toplamı (~350 km + ~200 km) ve harita görüntüsü.
  expect(html).toMatch(/5\d\d(,\d)? km/);
  expect(html).toContain("data:image/png;base64");
});

test.describe("klasik", () => {
  test.use({ classic: true });
  test("geziye göre gruplama", async ({ app }) => {
    await app.locator('select[title="Gruplama"]').selectOption("trip");
    await expect(app.locator(".file-list .group-label", { hasText: "Ankara gezisi" }).first()).toBeVisible();
  });
});
