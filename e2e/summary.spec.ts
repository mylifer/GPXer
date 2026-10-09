import { emit, expect, test } from "./app";

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

test("Özet: kayıtsız dönem fotoğraflardan doldurulur ya da bilerek boş işaretlenir", async ({ app, mock }) => {
  const added: string[] = [];
  mock.add_gpx_record = (a) => {
    added.push(a.name as string);
    return { status: "error", path: "x", message: "test" };
  };
  const watched: string[][] = [];
  mock["plugin:dialog|open"] = () => ["/f"];
  mock.read_photos = () => [];
  mock.watch_photo_folders = (a) => {
    watched.push(a.folders as string[]);
    return [];
  };
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Fotoğraf klasörü ekle");
  await app.keyboard.press("Enter");
  await expect.poll(() => watched.at(-1)).toEqual(["/f"]);
  // Ankara gezisiyle Bodrum arasındaki boşlukta (Ocak 2024) çekilmiş iki fotoğraf.
  await emit(app, "photos-added", [
    { path: "/f/1.jpg", name: "1.jpg", time: Date.parse("2024-01-05T10:00:00Z"), timeIsLocal: false, lat: 38.4, lon: 27.1, thumb: null },
    { path: "/f/2.jpg", name: "2.jpg", time: Date.parse("2024-01-05T12:00:00Z"), timeIsLocal: false, lat: 38.5, lon: 27.2, thumb: null },
  ]);
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  const first = app.getByTestId("coverage-gaps").locator("li").first();
  await expect(first).toContainText("08.07.2024");
  await first.getByRole("button", { name: "📷 2 fotoğraftan iz" }).click();
  await expect.poll(() => added).toEqual(["Fotoğraflardan iz 05.01.2024"]);

  await app.getByRole("button", { name: /^Özet/ }).first().click();
  const gaps = app.getByTestId("coverage-gaps").locator("li");
  const n = await gaps.count();
  await gaps.first().getByRole("button", { name: "Bilerek boş" }).click();
  await expect(gaps).toHaveCount(n - 1);
  await expect(app.getByTestId("coverage-gaps").locator("li").first()).not.toContainText("08.07.2024");
  await app.getByRole("button", { name: "1 dönem bilerek boş işaretli · göster" }).click();
  await expect(app.locator(".coverage-gaps li.quiet")).toHaveCount(1);
});
