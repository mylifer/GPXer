import { expect, test } from "./app";

test("kişiler: kayda eklenir, Özet'te listelenir, ada tıklanınca liste süzülür", async ({ app, mock }) => {
  const saved: unknown[] = [];
  mock.get_meta = () => ({ "/kutuphane/kayit-3.gpx": { tags: [], note: "", activity: null, people: ["Babam"] } });
  mock.set_meta = (a) => {
    saved.push(a.value);
    return null;
  };
  await app.reload();
  const rows = app.locator(".file-row");
  await rows.first().waitFor({ state: "attached" });
  await rows.filter({ hasText: "Marmaris → Datça" }).click();
  const input = app.getByLabel("Kimlerle? Kişi ekle…");
  await input.fill("Babam");
  await input.press("Enter");
  await expect.poll(() => saved.at(-1)).toMatchObject({ people: ["Babam"] });
  await expect(app.locator(".tag.person")).toContainText("Babam");

  await app.getByRole("button", { name: /^Özet/ }).first().click();
  const table = app.getByTestId("people");
  await expect(table).toContainText("Babam");
  await expect(table.locator("tbody tr").first().locator("td").nth(2)).toHaveText("2");
  await table.getByRole("button", { name: /Babam/ }).click();
  await expect(rows).toHaveCount(2);
});

test("kişi albümü: kişiyle yapılan yolculuklar PDF olarak kaydedilir", async ({ app, mock }) => {
  let saved = "";
  let name = "";
  mock.get_meta = () => ({
    "/kutuphane/kayit-3.gpx": { tags: [], note: "", activity: null, people: ["Babam"] },
    "/kutuphane/kayit-7.gpx": { tags: [], note: "", activity: null, people: ["Babam"] },
  });
  mock.pick_save_path = (a) => {
    name = a.defaultName as string;
    return `/Belgeler/${name}`;
  };
  mock.write_base64_file = (a) => {
    saved = a.data as string;
    return null;
  };
  await app.reload();
  await app.locator(".file-row").first().waitFor({ state: "attached" });
  await app.getByRole("button", { name: /^Özet/ }).first().click();
  await app.getByTestId("people").getByRole("button", { name: "📖 Albüm" }).click();
  await expect.poll(() => saved.length, { timeout: 20_000 }).toBeGreaterThan(1000);
  expect(name).toBe("GPXer-Babam-albumu.pdf");
  const pdf = Buffer.from(saved, "base64").toString("latin1");
  // Kapak + Temmuz 2024 + Eylül 2025.
  expect(pdf).toContain("/Count 3");
});
