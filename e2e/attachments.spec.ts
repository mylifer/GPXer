import { expect, test } from "./app";

test("kayda belge iliştirme: eklenir, açılır, kaldırılır", async ({ app, mock }) => {
  const opened: string[] = [];
  let removed = "";
  mock["plugin:dialog|open"] = () => ["/Users/ben/Belgeler/feribot-bileti.pdf"];
  mock.attach_files = (a) => ({ tags: [], note: "", activity: null, people: [], attachments: [`1720000000000-${(a.files as string[])[0].split("/").pop()}`] });
  mock.open_attachment = (a) => {
    opened.push(a.name as string);
    return null;
  };
  mock.remove_attachment = (a) => {
    removed = a.name as string;
    return { tags: [], note: "", activity: null, people: [], attachments: [] };
  };
  const rows = app.locator(".file-row");
  await rows.filter({ hasText: "Marmaris → Datça" }).click();
  await app.getByRole("button", { name: "📎 Belge ekle…" }).click();
  const doc = app.getByRole("button", { name: "📎 feribot-bileti.pdf" });
  await expect(doc).toBeVisible();
  await doc.click();
  await expect.poll(() => opened).toEqual(["1720000000000-feribot-bileti.pdf"]);
  await app.getByRole("button", { name: "feribot-bileti.pdf belgesini kaldır" }).click();
  await expect(doc).toHaveCount(0);
  expect(removed).toBe("1720000000000-feribot-bileti.pdf");
});
