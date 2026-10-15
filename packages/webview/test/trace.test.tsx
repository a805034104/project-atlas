// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import type { FlowDetailData, RuntimeStats } from "@project-atlas/core";
import { openView } from "./helpers.js";
import { flowListData, runtimeState, traceData, traceDetail, userListDetail, USER_LIST_EP } from "../src/dev/mock.js";

const stats = (count: number, p95: number, errors = 0): RuntimeStats => ({ count, p50Ms: p95 / 2, p95Ms: p95, errorCount: errors, lastSeen: "2026-10-15T14:02:11.000Z", sampleTraceIds: [] });

describe("Trace tab", () => {
  it("empty: offers copy VM options (primary) and launch, plus a request that needs no login", () => {
    const h = openView("trace", { payload: { view: "trace", data: traceData(false) } });
    expect(screen.getByRole("heading", { name: "See which steps really run" })).toBeTruthy();
    const primary = screen.getByRole("button", { name: "Copy VM options (IDEA / Eclipse / java -jar)" });
    expect(primary.className).toContain("primary");
    fireEvent.click(primary);
    expect(h.lastSent("runtimeAction")).toMatchObject({ type: "runtimeAction", action: "copyVmOptions" });
    fireEvent.click(screen.getByRole("button", { name: "Launch with tracing" }));
    expect(h.lastSent("runtimeAction")).toMatchObject({ action: "launch" });
    expect(screen.getByText("curl http://localhost:8080/captchaImage")).toBeTruthy();
  });

  it("restricted mode hides the launch actions", () => {
    const data = traceData(false);
    const h = openView("trace", { payload: { view: "trace", data: { ...data, runtime: { ...data.runtime, trusted: false } } } });
    h.emit({ type: "runtimeState", state: { ...runtimeState("off"), trusted: false } });
    expect(screen.queryByRole("button", { name: "Launch with tracing" })).toBeNull();
    expect(screen.getByText(/Restricted Mode/)).toBeTruthy();
  });

  it("lists traces newest first, requests the waterfall and opens the flow in single-trace mode", () => {
    const h = openView("trace", { payload: { view: "trace", data: traceData(true) } });
    h.emit({ type: "runtimeState", state: runtimeState("receiving") });
    expect(screen.getByRole("status").textContent).toContain("127.0.0.1:43180");
    expect(screen.getByRole("status").textContent).toContain("3 rejected");
    const rows = [...h.container.querySelectorAll(".trace-table tbody tr")];
    expect(rows.map((r) => r.querySelector(".code")?.textContent)).toEqual(["GET /system/user/list", "GET /captchaImage ⚠"]);
    expect(rows[0]?.textContent).toContain("90%"); // 9 of 10 steps observed
    const first = h.lastSent("requestTrace");
    expect(first?.traceId).toMatch(/^4f2a/);

    h.emit({ type: "traceDetail", data: traceDetail(first?.traceId ?? "") as never });
    const wf = [...h.container.querySelectorAll(".waterfall-row")];
    expect(wf).toHaveLength(10);
    expect(wf.filter((r) => r.classList.contains("unmatched")).map((r) => r.querySelector(".layer-badge")?.textContent)).toContain("no static step");
    expect(h.container.querySelector(".waterfall-row .badge[title^='async']")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show on the flow" }));
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe("Flow");
    expect(h.lastSent("requestView")).toEqual({ type: "requestView", view: "flow" });
  });

  it("static vs observed lists drawn (→) and reachable-only (⇝) runtime calls", () => {
    openView("trace", { payload: { view: "trace", data: traceData(true) } });
    expect(screen.getByText(/2 of \d+ HTTP entrypoints observed/)).toBeTruthy();
    const items = [...document.querySelectorAll(".trace-diff li")].map((li) => li.textContent);
    expect(items[0]).toContain("→");
    expect(items[0]).toContain("drawn");
    expect(items[1]).toContain("⇝");
    expect(items[1]).toContain("reachable, not drawn");
  });

  it("keeps the list stable while a trace is selected; new rows wait behind 'N new ↑'", () => {
    const h = openView("trace", { payload: { view: "trace", data: traceData(true) } });
    const data = traceData(true);
    const newer = { ...(data.traces[0] as (typeof data.traces)[number]), traceId: "1".repeat(32), start: (data.traces[0]?.start ?? 0) + 5000, rootName: "GET /system/role/list" };
    h.emit({ type: "viewData", payload: { view: "trace", data: { ...data, traces: [newer, ...data.traces] } } });
    expect(h.container.querySelectorAll(".trace-table tbody tr")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "1 new ↑" }));
    expect(h.container.querySelectorAll(".trace-table tbody tr")).toHaveLength(3);
  });
});

describe("flow overlay", () => {
  function observedDetail(): FlowDetailData {
    const d = userListDetail();
    return {
      ...d,
      entrypoint: { ...d.entrypoint, observed: stats(12, 38.4) },
      steps: d.steps.map((s) => (s.id === "s-ctrl" ? { ...s, observed: stats(12, 30.2) } : s.id === "s-svc" ? { ...s, observed: stats(12, 21, 2) } : s)),
      edges: d.edges.map((e) => (e.id === "e-svc-mapper" ? { ...e, observed: stats(12, 12.4, 1) } : e)),
    };
  }

  it("shows ✓ p95 badges on observed steps, count · p95 and errors on edges, and a request summary", () => {
    const h = openView("flow", { payload: { view: "flow", data: flowListData() }, persisted: { selectedEntrypointId: USER_LIST_EP } });
    h.emit({ type: "flowDetail", data: observedDetail() });
    const badges = [...h.container.querySelectorAll(".badge-observed")].map((b) => b.textContent);
    expect(badges).toEqual(expect.arrayContaining(["✓ 30.2 ms", "✓ 21 ms"]));
    expect(h.container.querySelector(".badge-observed.badge-error")?.textContent).toBe("✓ 21 ms");
    expect(h.container.querySelector('.edge-label[data-edge-id="e-svc-mapper"]')?.textContent).toBe("✓ 12× · p95 12.4ms ⚠ 1/12");
    expect(h.container.querySelector(".observed-summary")?.textContent).toBe("✓ 12 requests · p50 19.2 ms · p95 38.4 ms");
  });

  it("single-trace mode: banner, that trace's durations, untouched steps dimmed, exit restores aggregates", () => {
    const h = openView("trace", { payload: { view: "trace", data: traceData(true) } });
    h.emit({ type: "traceDetail", data: traceDetail(traceData(true).traces[0]?.traceId ?? "") as never });
    fireEvent.click(screen.getByRole("button", { name: "Show on the flow" }));
    h.emit({ type: "viewData", payload: { view: "flow", data: flowListData() } });
    h.emit({ type: "flowDetail", data: observedDetail() });
    expect(screen.getByText(/Showing one trace \(4f2a9c0e/)).toBeTruthy();
    expect(h.container.querySelector('[data-node-id="s-ctrl"] .badge-observed')?.textContent).toBe("30.2 ms");
    expect(h.container.querySelector('[data-node-id="s-ext"]')?.className).toContain("dim");
    expect(h.container.querySelector('[data-node-id="s-sql"]')?.className).not.toContain("dim");
    expect(h.container.querySelector('[data-node-id="s-ctrl"]')?.className).not.toContain("dim");
    fireEvent.click(screen.getByRole("button", { name: "Back to all requests" }));
    expect(h.container.querySelector(".lane-node.dim")).toBeNull();
    expect(h.container.querySelector('[data-node-id="s-ctrl"] .badge-observed')?.textContent).toBe("✓ 30.2 ms");
  });

  it("refetches the open flow when runtime stats change", () => {
    const h = openView("flow", { payload: { view: "flow", data: flowListData() }, persisted: { selectedEntrypointId: USER_LIST_EP } });
    h.emit({ type: "flowDetail", data: userListDetail() });
    const before = h.sent.filter((m) => m.type === "requestFlow").length;
    h.emit({ type: "runtimeUpdated" });
    expect(h.sent.filter((m) => m.type === "requestFlow").length).toBe(before + 1);
  });
});

describe("topology MQ channels", () => {
  it("draws one pill node per topic between producers and consumers", async () => {
    const { topologyData } = await import("../src/dev/mock.js");
    const base = topologyData();
    const mq = (id: string, from: string, to: string, channel: string) => ({ id, fromServiceId: from, toServiceId: to, kind: "mq" as const, channel, fromStepId: "x", provenance: "framework-rule" as const, confidence: 1, evidence: [] });
    const data = { ...base, links: [...base.links, mq("m1", "svc-system", "svc-auth", "kafka:order-created"), mq("m2", "svc-gateway", "svc-auth", "kafka:order-created")] };
    const h = openView("topology", { payload: { view: "topology", data }, showTopology: true });
    const pills = [...h.container.querySelectorAll(".graph-node.pill")];
    expect(pills).toHaveLength(1);
    expect(pills[0]?.getAttribute("aria-label")).toBe("kafka order-created: 2 producing service(s), 1 consuming service(s)");
  });
});
