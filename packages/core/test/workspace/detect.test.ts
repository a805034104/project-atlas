import { describe, expect, it } from "vitest";
import { detectProject } from "../../src/workspace/detect.js";
import { FIXTURES, haveFixtures, loadFixture } from "../helpers/fixtures.js";

describe.skipIf(!haveFixtures(FIXTURES.ruoyiVue, FIXTURES.ruoyiVue3))("RuoYi-Vue + RuoYi-Vue3", () => {
  it("detects one backend service, one frontend app and the maven modules", async () => {
    const project = detectProject(await loadFixture(FIXTURES.ruoyiVue, FIXTURES.ruoyiVue3));
    expect(project.java.map((j) => [j.service.name, j.service.kind, j.port])).toEqual([["ruoyi-admin", "backend", 8080]]);
    expect(project.java[0]?.classpath.map((c) => c.dir).sort()).toEqual(["ruoyi-admin", "ruoyi-common", "ruoyi-framework", "ruoyi-generator", "ruoyi-quartz", "ruoyi-system"]);
    const buildModules = project.modules.filter((m) => m.kind === "build-module").map((m) => m.name).sort();
    expect(buildModules).toEqual(["ruoyi-admin", "ruoyi-common", "ruoyi-framework", "ruoyi-generator", "ruoyi-quartz", "ruoyi-system"]);
    const admin = project.modules.find((m) => m.name === "ruoyi-admin");
    expect(admin?.dependsOn.length).toBeGreaterThanOrEqual(3);
    expect(admin?.fileCount).toBeGreaterThan(10);

    const ui = project.frontends[0];
    expect(ui?.service.kind).toBe("frontend");
    expect(ui?.baseApi).toBe("/dev-api");
    expect(ui?.proxies).toMatchObject([
      { prefix: "/dev-api", target: "http://localhost:8080", stripPrefix: true },
      { prefix: "^/v3/api-docs/(.*)", target: "http://localhost:8080", stripPrefix: false },
    ]);
    expect(project.modules.filter((m) => m.serviceId === ui?.service.id).map((m) => m.name)).toContain("views/system");
  });
});

describe.skipIf(!haveFixtures(FIXTURES.ruoyiCloud, FIXTURES.ruoyiCloudVue3))("RuoYi-Cloud + RuoYi-Cloud-Vue3", () => {
  it("detects every service with names from bootstrap.yml and ports", async () => {
    const project = detectProject(await loadFixture(FIXTURES.ruoyiCloud, FIXTURES.ruoyiCloudVue3));
    const services = Object.fromEntries(project.java.map((j) => [j.service.name, { kind: j.service.kind, port: j.port, profiles: j.profiles }]));
    expect(services).toMatchObject({
      "ruoyi-gateway": { kind: "gateway", port: 8080, profiles: ["dev"] },
      "ruoyi-auth": { kind: "backend", port: 9200 },
      "ruoyi-system": { kind: "backend", port: 9201 },
      "ruoyi-gen": { kind: "backend", port: 9202 },
      "ruoyi-job": { kind: "backend", port: 9203 },
      "ruoyi-file": { kind: "backend", port: 9300 },
      "ruoyi-monitor": { kind: "backend", port: 9100 },
    });
  });

  it("layers Nacos configs from the SQL dump on top of bootstrap.yml", async () => {
    const project = detectProject(await loadFixture(FIXTURES.ruoyiCloud, FIXTURES.ruoyiCloudVue3));
    expect(project.nacos.map((r) => r.dataId)).toContain("ruoyi-gateway-dev.yml");
    const gateway = project.java.find((j) => j.service.name === "ruoyi-gateway");
    const routes = gateway?.config.list("spring.cloud.gateway.routes") ?? [];
    expect(routes.some((e) => e.value === "lb://ruoyi-system")).toBe(true);
    expect(routes.find((e) => e.value === "lb://ruoyi-system")?.at.file).toBe("sql/ry_config_20250902.sql");
    // shared-configs application-dev.yml is visible to every service
    const system = project.java.find((j) => j.service.name === "ruoyi-system");
    expect(system?.config.get("feign.okhttp.enabled")?.value).toBe("true");
  });
});
