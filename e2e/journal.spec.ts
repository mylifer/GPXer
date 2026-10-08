import { expect, test } from "./app";

test.use({ now: "2025-07-09T12:00:00+03:00" });

test("günlük notu: gün akışında yazılır, kaydedilir; geçmiş yıllarda bugün kartında görünür", async ({ app, mock }) => {
  const saved: [string, string][] = [];
  mock.get_journal = () => ({ "2024-07-09": "Babamla Bodrum'dan Marmaris'e" });
  mock.set_day_note = (a) => {
    saved.push([a.day as string, a.text as string]);
    return null;
  };
  await app.reload();
  await app.locator(".file-row").first().waitFor({ state: "attached" });
  await expect(app.locator(".otd-card")).toContainText("Babamla Bodrum'dan Marmaris'e");
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Gün akışı");
  await app.keyboard.press("Enter");
  await app.getByLabel("Gün", { exact: true }).fill("10.07.2024");
  const note = app.getByLabel("Günün notu");
  await note.fill("Marmaris'ten Datça'ya, Knidos'u gezdik");
  await expect.poll(() => saved.at(-1)).toEqual(["2024-07-10", "Marmaris'ten Datça'ya, Knidos'u gezdik"]);
  await app.getByLabel("Gün", { exact: true }).fill("09.07.2024");
  await expect(note).toHaveValue("Babamla Bodrum'dan Marmaris'e");
});
