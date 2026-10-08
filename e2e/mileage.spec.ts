import { expect, test } from "./app";

test("kilometre defteri: etiketli yolculuklar, aylık toplam ve CSV", async ({ app, mock }) => {
  let csv = "";
  mock.get_meta = () => ({
    "/kutuphane/kayit-3.gpx": { tags: ["iş"], note: "", activity: null },
    "/kutuphane/kayit-4.gpx": { tags: ["iş"], note: "Müşteri ziyareti", activity: null },
    "/kutuphane/kayit-6.gpx": { tags: ["iş"], note: "", activity: null },
  });
  mock.pick_save_path = (a) => `/Belgeler/${a.defaultName}`;
  mock.write_text_file = (a) => {
    csv = a.contents as string;
    return null;
  };
  await app.reload();
  await app.locator(".file-row").first().waitFor({ state: "attached" });
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Kilometre");
  await app.keyboard.press("Enter");
  await app.getByLabel("Yıl", { exact: true }).selectOption("2024");
  await expect(app.getByTestId("mileage-total")).toContainText("2 yolculuk");
  await expect(app.getByTestId("mileage-months").locator("tbody tr")).toHaveCount(1);
  await app.getByRole("button", { name: "CSV olarak kaydet…" }).click();
  await expect.poll(() => csv).toContain("Müşteri ziyareti");
  expect(csv).toContain("Toplam;2;");
});
