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
    await app
      .getByRole("button", { name: /^Summary/ })
      .first()
      .click();
    const sum = app.locator(".abroad-regions");
    await expect(sum.first()).toBeVisible({ timeout: 15_000 });
    const text = (await sum.allInnerTexts()).join(" ");
    expect(text).toContain("Germany");
    expect(text).toContain("Bavaria");
    expect(text).toMatch(/\d+ \/ \d+ regions/);
  });
});

test("Özet: kayıt kapsamı tablosu ve kayıtsız dönemler", async ({ app }) => {
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  const table = app.getByTestId("coverage");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").first().locator("th")).toHaveText("2025");
  // En uzun boşluk: Mayıs 2023'teki Ankara gezisiyle Temmuz 2024'teki Bodrum arası.
  await expect(app.getByTestId("coverage-gaps").locator("li").first()).toContainText("08.07.2024");
  await app.getByTitle(/^Temmuz 2024: /).click();
  await expect(app.locator(".file-row")).toHaveCount(3);
});

test("Özet: yıllık albüm PDF olarak kaydedilir (kapak + kayıtlı her ay)", async ({ app, mock }) => {
  let saved = "";
  mock.pick_save_path = (a) => `/Belgeler/${a.defaultName}`;
  mock.write_base64_file = (a) => {
    saved = a.data as string;
    return null;
  };
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  await app.getByLabel("Yıl", { exact: true }).last().selectOption("2025");
  await app.getByRole("button", { name: "📖 Albüm (PDF)…" }).click();
  await expect.poll(() => saved.length, { timeout: 20_000 }).toBeGreaterThan(1000);
  const pdf = Buffer.from(saved, "base64").toString("latin1");
  expect(pdf.startsWith("%PDF-1.4")).toBe(true);
  // 2025: Ağustos (Edirne → Selanik) ve Eylül (Münih → Augsburg).
  expect(pdf).toContain("/Count 3");
  await expect(app.getByText("Albüm kaydedildi.")).toBeVisible();
});
