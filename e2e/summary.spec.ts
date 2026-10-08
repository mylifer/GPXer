import { expect, test } from "./app";

test("Özet: Türkiye illeri ve yurtdışı bölgeler", async ({ app }) => {
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  const sum = app.locator(".abroad-regions");
  await expect(sum.first()).toBeVisible({ timeout: 15_000 });
  await expect(app.getByText(/Gezilen iller: \d+ \/ 81/)).toBeVisible();
  const text = (await sum.allInnerTexts()).join(" ");
  expect(text).toContain("Almanya");
  expect(text).toContain("Bavyera");
});

test.describe("İngilizce", () => {
  test.use({ en: true });
  test("arayüz ve bölge adları İngilizce", async ({ app }) => {
    await expect(app.getByText("Kayıtlar", { exact: true })).toHaveCount(0);
    await app.getByRole("button", { name: /^Summary/ }).first().click();
    const sum = app.locator(".abroad-regions");
    await expect(sum.first()).toBeVisible({ timeout: 15_000 });
    const text = (await sum.allInnerTexts()).join(" ");
    expect(text).toContain("Germany");
    expect(text).toContain("Bavaria");
    expect(text).toMatch(/\d+ \/ \d+ regions/);
  });
});
