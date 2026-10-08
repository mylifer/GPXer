import { emit, expect, test } from "./app";

test("fotoğraf klasörü: eklenen klasör izlenir, yeni fotoğraflar kendiliğinden haritaya gelir", async ({ app, mock }) => {
  const watched: string[][] = [];
  mock.watch_photo_folders = (a) => {
    watched.push(a.folders as string[]);
    return [];
  };
  mock["plugin:dialog|open"] = () => ["/Resimler/Telefon"];
  mock.read_photos = () => [];
  await app.keyboard.press("Control+k");
  await app.locator(".palette input").fill("fotoğraf klasörü");
  await app.keyboard.press("Enter");
  await expect.poll(() => watched.at(-1)).toEqual(["/Resimler/Telefon"]);
  // Klasöre Bodrum → Marmaris yolculuğu sırasında çekilmiş bir fotoğraf düşer.
  await emit(app, "photos-added", [
    { path: "/Resimler/Telefon/IMG_1.jpg", name: "IMG_1.jpg", time: Date.parse("2024-07-09T07:10:00Z"), timeIsLocal: false, lat: 37.0, lon: 27.6, thumb: null },
  ]);
  await expect(app.getByText("Fotoğraf klasöründe 1 yeni fotoğraf; 1 tanesi haritada.")).toBeVisible();
});
