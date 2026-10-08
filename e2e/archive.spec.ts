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

test("açık arşiv olarak dışa aktarma", async ({ app, mock }) => {
  mock.archive_info = () => ({ lastBackup: null, lastAutoBackup: null, lastCheck: null });
  mock.export_open_archive = () => ({ folder: "/Volumes/Yedek/GPXer-arsiv-2025-07-09", records: 7 });
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Ayarlar");
  await app.keyboard.press("Enter");
  await app.getByRole("button", { name: "Açık arşiv olarak dışa aktar…" }).click();
  await expect(app.getByText("7 kayıt açık arşiv olarak yazıldı: /Volumes/Yedek/GPXer-arsiv-2025-07-09")).toBeVisible();
});

test("Ayarlar → Arşiv: ikinci yedek klasörü ve yedek doğrulama", async ({ app, mock }) => {
  let saved: Record<string, unknown> | null = null;
  mock.archive_info = () => ({ lastBackup: Date.now(), lastAutoBackup: Date.now(), lastCheck: null, lastVerify: null });
  mock.get_settings = () => ({
    stats: { movingSpeedMs: 0.5, elevationThresholdM: 3, cleanSpikes: true, perType: false, collapseStays: true },
    watchedFolders: [],
    syncFolder: null,
    backupFolder: "/Volumes/Yedek/GPXer",
    backupDays: 7,
  });
  mock.verify_last_backup = () => ({
    path: "/Volumes/Yedek/GPXer/GPXer-otomatik-yedek-2025-07-01.zip",
    records: 7,
    ok: 6,
    bad: ["kayit-3.gpx"],
    absent: [],
    metaOk: true,
  });
  mock["plugin:dialog|open"] = () => "/Users/ben/Drive/GPXer";
  mock.set_settings = (a) => {
    saved = a.settings as Record<string, unknown>;
    return [];
  };
  await app.reload();
  await app.locator(".file-row").first().waitFor({ state: "attached" });
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Ayarlar");
  await app.keyboard.press("Enter");
  await app.getByRole("button", { name: "Yedeği doğrula" }).click();
  const v = app.getByTestId("backup-verify");
  await expect(v).toContainText("1 kayıt bozuk (kayit-3.gpx)");
  await expect(v).toHaveClass(/error/);
  await app.getByRole("button", { name: "İkinci klasör seç…" }).click();
  await expect(app.getByTestId("backup-folder2")).toHaveText("/Users/ben/Drive/GPXer");
  await app.getByRole("button", { name: "Kaydet", exact: true }).click();
  await expect.poll(() => saved).not.toBeNull();
  expect(saved!.backupFolder2).toBe("/Users/ben/Drive/GPXer");
});
