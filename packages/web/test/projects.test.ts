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

describe("analysis lock", () => {
  it("a dialog left open in one project (AI cost) does not hold up another project's analysis", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-lock-home-"));
    await writeFile(path.join(home, "web-settings.json"), JSON.stringify({ provider: "anthropic", model: "claude-opus-5-5" }));
    await writeFile(path.join(home, "credentials.json"), JSON.stringify({ anthropic: { key: "test-key-not-sent", endpoint: "default" } }));
    const settings = await SettingsStore.open(home, "en");
    const registry = await ProjectRegistry.open({ home, settings, assets: {}, log: () => {} });
    const dirs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const dir = await mkdtemp(path.join(tmpdir(), `atlas-lock-p${i}-`));
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "A.java"), "@RestController class A { @GetMapping(\"/a\") public String a() { return \"\"; } }\n");
      dirs.push(dir);
    }
    const a = (await registry.session((await registry.import(dirs[0]!, true)).record.id))!;
    const b = (await registry.session((await registry.import(dirs[1]!, false)).record.id))!;

    // A: trusted + AI configured → after parsing it asks for the AI cost and nobody answers.
    const aDone = a.runCommand("atlas.analyze");
    const deadline = Date.now() + 60_000;
    while (a.prompts.pending().length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(a.prompts.pending().length).toBe(1);
    expect(a.controller.busy).toBe(true);

    // B (untrusted: no AI) must finish while A's question is still open.
    await Promise.race([b.runCommand("atlas.analyze"), new Promise((_, reject) => setTimeout(() => reject(new Error("B was blocked by A's open dialog")), 30_000))]);
    expect(b.controller.state.status).toBe("done");
    expect(a.prompts.pending().length).toBe(1);

    a.prompts.cancelAll(); // decline: A finishes with the deterministic map only
    await aDone;
    expect(a.controller.state.status).toBe("done");
    await registry.close();
  }, 120_000);
});
