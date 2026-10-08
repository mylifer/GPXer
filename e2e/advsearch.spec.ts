import { expect, test } from "./app";

test("gelişmiş arama: ölçütler önizlenir, arama adıyla kaydedilir ve paletten yeniden uygulanır", async ({ app }) => {
  const rows = app.locator(".file-row");
  await rows.first().waitFor({ state: "attached" });
  const all = await rows.count();
  await app.getByRole("button", { name: /Gelişmiş arama/ }).first().click();
  await expect(app.getByTestId("adv-count")).toHaveText(`${all} kayıt uyuyor.`);
  // Fikstürlerde yalnızca Münih → Augsburg cumartesi.
  await app.getByLabel("Günler").selectOption("weekend");
  await expect(app.getByTestId("adv-count")).toHaveText("1 kayıt uyuyor.");
  await app.getByLabel("Arama adı").fill("Hafta sonu gezileri");
  await app.getByRole("button", { name: "Aramayı kaydet" }).click();
  await expect(app.locator("fieldset", { hasText: "Kayıtlı aramalar" })).toContainText("Hafta sonu gezileri");
  await app.getByLabel("Günler").selectOption("");
  await app.getByLabel("En az km").fill("300");
  const long = Number((await app.getByTestId("adv-count").textContent())!.split(" ")[0]);
  expect(long).toBeGreaterThan(0);
  expect(long).toBeLessThan(all);
  await app.getByRole("button", { name: "Uygula" }).click();
  await expect(rows).toHaveCount(long);

  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("Kayıtlı arama: Hafta");
  await app.keyboard.press("Enter");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Münih → Augsburg");
});
