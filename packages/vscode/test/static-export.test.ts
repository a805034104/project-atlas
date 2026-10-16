import { describe, expect, it } from "vitest";
import { emptyGraph } from "@project-atlas/core";
import { renderStaticHtml } from "@project-atlas/core";

describe("single-file HTML export", () => {
  const graph = emptyGraph("0.1.0", "evil</script><script>alert(1)</script>", new Date("2026-10-15T00:00:00Z"));
  graph.diagnostics.push({ code: "ATLAS-W003", severity: "warning", message: "line separator </script> & <b>" });
  const html = renderStaticHtml(graph, { js: "console.log('</script>')", css: "body{}" }, "zh-cn");

  it("never lets embedded data or bundle text close the script element", () => {
    const scripts = html.split("<script>").slice(1).map((chunk) => chunk.split("</script>")[0] ?? "");
    expect(scripts).toHaveLength(3);
    expect(html.match(/<\/script>/g)?.length).toBe(3);
    expect(html).not.toContain(" ");
    expect(html).toContain("<title>evil&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; · ProjectAtlas</title>");
  });

  it("embeds every view payload and the vscode API shim", () => {
    const dataScript = html.split("<script>")[1]?.split("</script>")[0] ?? "";
    const json = dataScript.replace(/^window\.__ATLAS_STATIC__ = /, "").replace(/;$/, "");
    const data = JSON.parse(json) as { locale: string; payloads: Record<string, unknown>; flows: Record<string, unknown> };
    expect(data.locale).toBe("zh-cn");
    expect(Object.keys(data.payloads).sort()).toEqual(["features", "flow", "history", "modules", "overview", "startup", "topology"]);
    expect(html).toContain("window.acquireVsCodeApi = function");
    expect(html).toContain('lang="zh-CN"');
  });
});
