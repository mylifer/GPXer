import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { archiveInfo, type ArchiveReport, type BackupVerify, type Settings } from "../api";
import { fmtNumber } from "../format";
import { t } from "../i18n";

const DAY = 86_400_000;
/** Otomatik yedek yokken bu kadar gün yedek alınmazsa hatırlatılır. */
const REMIND_DAYS = 30;
const REMIND_KEY = "gpxer.backupReminded";

/** Sağlık denetiminin özeti (sorun yoksa null). */
export function reportProblems(r: ArchiveReport): string | null {
  const parts = [
    r.missing.length && t(`${fmtNumber(r.missing.length)} kayıt diskte bulunamadı`),
    r.corrupted.length && t(`${fmtNumber(r.corrupted.length)} kaydın içeriği bozulmuş olabilir`),
    r.unreadable.length && t(`${fmtNumber(r.unreadable.length)} kayıt okunamadı`),
  ].filter((x): x is string => !!x);
  if (!parts.length) return null;
  const names = [...r.corrupted, ...r.missing, ...r.unreadable].slice(0, 3).map((p) => p.split(/[\\/]/).pop());
  return `${t("Arşiv denetimi:")} ${parts.join("; ")} (${names.join(", ")}${r.corrupted.length + r.missing.length + r.unreadable.length > 3 ? "…" : ""}).`;
}

/** Yedek doğrulamasının özeti ve sorun olup olmadığı. */
export function verifySummary(v: BackupVerify): { text: string; bad: boolean } {
  const name = v.path.split(/[\\/]/).pop();
  const issues = [
    v.bad.length && t(`${fmtNumber(v.bad.length)} kayıt bozuk (${v.bad.slice(0, 3).join(", ")}${v.bad.length > 3 ? "…" : ""})`),
    v.absent.length && t(`${fmtNumber(v.absent.length)} kayıt yedekte yok`),
    !v.metaOk && t("kayıt bilgileri okunamadı"),
  ].filter((x): x is string => !!x);
  if (issues.length) return { text: `${t("Yedek doğrulaması:")} ${name}: ${issues.join("; ")}.`, bad: true };
  return { text: t(`Yedek açılabiliyor: ${name}, ${fmtNumber(v.records)} kaydın hepsi sağlam.`), bad: false };
}

/** Arşiv bildirimleri: otomatik yedek ve haftalık denetim sonuçları; uzun
 * süredir yedek alınmadıysa (otomatik yedek kapalıyken) hatırlatma. */
export function useArchive({ settings, records, say, fail }: { settings: Settings | null; records: number; say(m: string): void; fail(m: string): void }) {
  useEffect(() => {
    const un = [
      listen<{ Ok?: string; Err?: string }>("archive-backup", (e) => {
        if (e.payload.Err) fail(e.payload.Err);
        else say(`${t("Otomatik yedek alındı:")} ${e.payload.Ok?.split(/[\\/]/).pop()}`);
      }),
      listen<{ Ok?: BackupVerify; Err?: string }>("archive-verify", (e) => {
        if (e.payload.Err) fail(`${t("Yedek doğrulanamadı:")} ${e.payload.Err}`);
        else if (e.payload.Ok) {
          const v = verifySummary(e.payload.Ok);
          if (v.bad) fail(v.text);
          else say(v.text);
        }
      }),
      listen<ArchiveReport>("archive-health", (e) => {
        const p = reportProblems(e.payload);
        if (p) fail(p);
      }),
    ];
    return () => un.forEach((p) => p.then((fn) => fn()));
  }, [say, fail]);

  const auto = !!settings?.backupFolder;
  useEffect(() => {
    if (auto || records === 0 || !settings) return;
    const timer = setTimeout(async () => {
      const today = new Date().toISOString().slice(0, 10);
      try {
        if (localStorage.getItem(REMIND_KEY) === today) return;
      } catch {
        // depo yoksa yine hatırlatılır
      }
      const info = await archiveInfo().catch(() => null);
      if (!info) return;
      const days = info.lastBackup == null ? null : Math.floor((Date.now() - info.lastBackup) / DAY);
      if (days != null && days < REMIND_DAYS) return;
      say(
        days == null
          ? "Arşivinizin hiç yedeği yok. Ayarlar → Arşiv'den otomatik yedek klasörü seçebilir ya da Yedek al… ile yedekleyebilirsiniz."
          : t(`Son yedek ${fmtNumber(days)} gün önce alındı. Ayarlar → Arşiv'den otomatik yedeği açabilirsiniz.`),
      );
      try {
        localStorage.setItem(REMIND_KEY, today);
      } catch {
        // yok say
      }
    }, 30_000);
    return () => clearTimeout(timer);
  }, [auto, records, settings]);
}
