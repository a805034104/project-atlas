import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectRegistry } from "../src/projects.js";
import { SettingsStore } from "../src/store.js";

async function setup(count: number) {
  const home = await mkdtemp(path.join(tmpdir(), "atlas-reg-home-"));
  const settings = await SettingsStore.open(home, "en");
  const registry = await ProjectRegistry.open({ home, settings, assets: {}, log: () => {} });
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const dir = await mkdtemp(path.join(tmpdir(), `atlas-reg-p${i}-`));
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "A.java"), "class A {}\n");
    ids.push((await registry.import(dir, false)).record.id);
  }
  return { registry, ids };
}

describe("project registry", () => {
  it("two requests for a project that is still loading share one session (no race with restore)", async () => {
    const { registry, ids } = await setup(1);
    const [a, b] = await Promise.all([registry.session(ids[0]!), registry.session(ids[0]!)]);
    expect(a).toBe(b);
    await registry.close();
  });

  it("opening a project beyond the limit never evicts the one being opened", async () => {
    const { registry, ids } = await setup(4);
    for (const id of ids.slice(0, 3)) {
      const s = await registry.session(id);
      s!.hub.connect({ writeHead: () => undefined, write: () => true, end: () => undefined, on: () => undefined } as never, []); // a connected tab
    }
    const fourth = await registry.session(ids[3]!);
    expect(await registry.session(ids[3]!)).toBe(fourth);
    await registry.close();
  });
});
