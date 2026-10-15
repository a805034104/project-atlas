import { existsSync } from "node:fs";
import path from "node:path";
import { stableId } from "../../src/model/ids.js";
import type { Root } from "../../src/model/types.js";
import { createParsePool } from "../../src/parse/pool.js";
import { loadWorkspace, type Workspace } from "../../src/workspace/load.js";

/** Upstream fixtures cloned into fixtures/repos (see fixtures/fixtures.json). */
export const FIXTURES = {
  ruoyiVue: path.resolve("fixtures/repos/ruoyi-vue"),
  ruoyiVue3: path.resolve("fixtures/repos/ruoyi-vue3"),
  ruoyiCloud: path.resolve("fixtures/repos/ruoyi-cloud"),
  ruoyiCloudVue3: path.resolve("fixtures/repos/ruoyi-cloud-vue3"),
};

export function haveFixtures(...dirs: string[]): boolean {
  return dirs.every((d) => existsSync(d));
}

export function rootFor(dir: string): Root {
  return { id: stableId("root", "", dir), path: dir, kind: "workspace" };
}

const cache = new Map<string, Promise<Workspace>>();

export function loadFixture(...dirs: string[]): Promise<Workspace> {
  const key = dirs.join("|");
  let loaded = cache.get(key);
  if (!loaded) {
    loaded = (async () => {
      const pool = await createParsePool({ size: 0 });
      try {
        return await loadWorkspace({ roots: dirs.map(rootFor), pool, analyzerVersion: "test" });
      } finally {
        await pool.close();
      }
    })();
    cache.set(key, loaded);
  }
  return loaded;
}
