import { expect, test } from "./app";

// Keşif testi: paletteki her komut çalıştırılır; çökme ya da sayfa hatası olmamalı.
for (const mode of [
  { name: "modern", classic: false, en: false },
  { name: "klasik", classic: true, en: false },
  { name: "İngilizce", classic: false, en: true },
]) {
  test.describe(mode.name, () => {
    test.use({ classic: mode.classic, en: mode.en });
    test("paletteki bütün komutlar", async ({ app, mock, errors }) => {
      test.setTimeout(240_000);
      mock["plugin:dialog|open"] = () => null;
      mock.pick_save_path = () => null;
      const open = async () => {
        await app.keyboard.press("Escape");
        await app.keyboard.press("Escape");
        await app.keyboard.press("Control+k");
        await app.locator(".palette").waitFor();
      };
      // Bir kayıt seçili olsun (kayda özgü komutlar da listelensin).
      await app.locator(".file-row").first().click();
      await open();
      const items = app.locator(".palette li:not(.muted)");
      const n = await items.count();
      const labels: string[] = [];
      for (let i = 0; i < n; i++) labels.push((await items.nth(i).locator(".palette-label").innerText()).trim());
      await app.keyboard.press("Escape");
      // Uygulamayı kapatan/yeniden başlatan ya da dosya silen komutlar atlanır.
      const skip = /çık|quit|güncelle|update|sil|delete|çöp|trash|geri yükle|restore|eşitle|sync/i;
      const ran: string[] = [];
      for (const [i, label] of labels.entries()) {
        if (skip.test(label)) continue;
        await open();
        await app.locator(".palette li:not(.muted)").nth(i).click();
        await app.waitForTimeout(250);
        ran.push(label);
        await expect(app.locator(".crash"), `çöktü: ${label}`).toHaveCount(0);
        expect(errors, `sayfa hatası: ${label}`).toEqual([]);
      }
      console.log(`${mode.name}: ${ran.length}/${labels.length} komut çalıştı`);
    });
  });
}
