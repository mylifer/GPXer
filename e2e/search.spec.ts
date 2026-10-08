import { expect, later, test } from "./app";

const KADIKOY_YALOVA = { name: "Kadıköy", detail: "Yalova, TR", lat: 40.62, lon: 29.22, bbox: null, kind: "city" };
const FIRIN = { name: "Fırın Sokak", detail: "Erenköy, Kadıköy, İstanbul, Türkiye", lat: 40.972, lon: 29.078, bbox: null, kind: "residential" };

for (const classic of [false, true]) {
  test.describe(classic ? "klasik" : "modern", () => {
    test.use({ classic });

    test("arama düğmesi paneli açar, Esc kapatır", async ({ app }) => {
      await expect(app.locator(".map-search-panel")).toHaveCount(0);
      await app.locator(".map-search > button").click();
      await expect(app.locator(".map-search-panel")).toBeVisible();
      await expect(app.getByLabel("Haritada ara", { exact: true })).toBeFocused();
      await app.keyboard.press("Escape");
      await expect(app.locator(".map-search-panel")).toHaveCount(0);
    });

    test("hızlı yazıp Enter: çevrimiçi sonucu bekleyip sokağa gider", async ({ app, mock }) => {
      mock.search_places_offline = (a) => later(200, /kad/i.test(a.query as string) ? [KADIKOY_YALOVA] : []);
      mock.search_places_online = (a) => later(800, /f[ıi]r[ıi]n/i.test(a.query as string) ? [FIRIN] : []);
      await app.keyboard.press("Control+f");
      await app.keyboard.type("fırın sokak kadıköy erenköy", { delay: 10 });
      await app.keyboard.press("Enter");
      await expect(app.locator(".search-pin")).toHaveAttribute("title", "Fırın Sokak", { timeout: 5000 });
      await expect(app.locator(".map-search-panel")).toHaveCount(0);
    });
  });
}

test("eski sorgunun sonucu yeni sorguya seçilmez", async ({ app, mock }) => {
  mock.search_places_offline = (a) =>
    later(300, [{ name: (a.query as string) === "kem" ? "Kemaliye" : "Kemer", detail: "TR", lat: 36.6, lon: 30.56, bbox: null, kind: "city" }]);
  await app.keyboard.press("Control+f");
  await app.keyboard.type("kem");
  await expect(app.locator(".map-search-results")).toContainText("Kemaliye");
  await app.keyboard.type("er");
  await app.keyboard.press("Enter");
  await expect(app.locator(".search-pin")).toHaveAttribute("title", "Kemer");
});

test("tanılama her kaynağın sonucunu gösterir", async ({ app, mock }) => {
  mock.streets_info = () => [1200, 40];
  mock.search_places_online = () => [];
  mock.search_trace = () => ["fırın sokak", ["Sorgu: “fırın sokak”", "Photon “fırın sokak”: 0 sonuç, 0 uyan, 120 ms"]];
  await app.keyboard.press("Control+f");
  await app.keyboard.type("fırın sokak");
  await app.getByRole("button", { name: /Tanılama/ }).click();
  const diag = app.locator(".map-search-diag");
  await expect(diag).toContainText("Çevrimdışı yerleşim listesi: 0 sonuç");
  await expect(diag).toContainText("dizinde 1200 ad, 40 karo");
  await expect(diag).toContainText("Photon “fırın sokak”: 0 sonuç");
});
