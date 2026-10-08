import { expect, test } from "./app";

test("Ayarlar → Arşiv: denetim sorunları gösterir, yedek klasörü kaydedilir", async ({ app, mock }) => {
  let saved: Record<string, unknown> | null = null;
  mock.archive_info = () => ({ lastBackup: null, lastAutoBackup: null, lastCheck: null });
  mock.archive_check = () => ({
    total: 7,
    ok: 5,
    missing: ["/kutuphane/kayit-2.gpx"],
    corrupted: ["/kutuphane/kayit-5.gpx"],
    unreadable: [],
    checkedAt: Date.now(),
    lastBackup: null,
  });
  mock["plugin:dialog|open"] = () => "/Volumes/Yedek/GPXer";
  mock.set_settings = (a) => {
    saved = a.settings as Record<string, unknown>;
    return [];
  };
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Ayarlar");
  await app.keyboard.press("Enter");
  await app.getByRole("button", { name: "Arşivi denetle" }).click();
  const report = app.getByTestId("archive-report");
  await expect(report).toContainText("1 kayıt diskte bulunamadı");
  await expect(report).toContainText("1 kaydın içeriği bozulmuş olabilir");
  await expect(report).toContainText("kayit-5.gpx");
  await app.getByRole("button", { name: "Yedek klasörü seç…" }).click();
  await app.getByLabel("Yedek aralığı").selectOption("30");
  await app.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect.poll(() => saved).not.toBeNull();
  expect(saved!.backupFolder).toBe("/Volumes/Yedek/GPXer");
  expect(saved!.backupDays).toBe(30);
  expect((saved!.stats as Record<string, unknown>).cleanSpikes).toBe(true);
});
