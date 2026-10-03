import { describe, expect, it } from "vitest";
import { inOrder } from "./api";

describe("inOrder", () => {
  it("runs each call after the previous one settles, even after a failure", async () => {
    const log: string[] = [];
    const save = inOrder(async (name: string, ms: number, fail = false) => {
      log.push(`start ${name}`);
      await new Promise((r) => setTimeout(r, ms));
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    });
    const a = save("a", 30, true);
    const b = save("b", 1);
    await expect(a).rejects.toThrow("a");
    await expect(b).resolves.toBe("b");
    expect(log).toEqual(["start a", "end a", "start b", "end b"]);
  });
});
