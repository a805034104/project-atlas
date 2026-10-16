// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { CallEdge, FlowDetailData, FlowStep } from "@project-atlas/core";
import { openView } from "./helpers.js";
import { entrypoints, flowListData, serviceRefs, userListDetail, USER_LIST_EP } from "../src/dev/mock.js";

function openFlow(detail: FlowDetailData = userListDetail()) {
  const h = openView("flow", {
    payload: { view: "flow", data: flowListData() },
    persisted: { selectedEntrypointId: detail.entrypoint.id },
  });
  h.emit({ type: "flowDetail", data: detail });
  return h;
}

const node = (name: RegExp | string) => screen.getByRole("button", { name });

describe("flow pyramid", () => {
  it("draws one frame per service and a rail naming the layers on each row, entry on top", () => {
    const h = openFlow();
    const frames = [...h.container.querySelectorAll(".pyramid .pyr-frame .band-header")].map((b) => b.textContent);
    expect(frames).toEqual(["▾ruoyi-ui (1 steps)", "▾ruoyi-gateway (1 steps)", "▾ruoyi-system (11 steps)", "▾ruoyi-auth (2 steps)"]);
    const rail = [...h.container.querySelectorAll(".pyr-rail-row")].map((r) => r.textContent);
    expect(rail[0]).toBe("frontend");
    expect(rail[1]).toBe("filter");
    const top = (name: RegExp) => Number.parseFloat((node(name) as HTMLElement).style.top);
    expect(top(/^user\.js listUser,/)).toBeLessThan(top(/^AuthFilter\.filter,/));
    expect(top(/^AuthFilter\.filter,/)).toBeLessThan(top(/^SysUserController\.list,/));
    expect(top(/^SysUserController\.list,/)).toBeLessThan(top(/^SysUserMapper\.selectUserList,/));
  });

  it("an aspect with one target is drawn beside it, not as a row of its own", () => {
    // The analyzer's shape: caller → aspect → advised method.
    const base = userListDetail();
    const viaAspect = { ...(base.edges.find((e) => e.id === "e-ctrl-aspect") as CallEdge), id: "e-aspect-svc", from: "s-aspect", to: "s-svc", order: 0 };
    const h = openFlow({ ...base, edges: [...base.edges, viaAspect] });
    const pill = h.container.querySelector(".pyr-sidecar");
    expect(pill?.getAttribute("aria-label")).toMatch(/advises/);
    expect(h.container.querySelector('.pyr-node.layer-aspect')).toBeNull();
  });

  it("node aria-labels name the layer and outgoing edge count", () => {
    openFlow();
    expect(node("SysUserController.list, controller layer, 2 outgoing edges")).toBeTruthy();
    expect(node("JwtAuthenticationTokenFilter.doFilterInternal, filter layer, 2 outgoing edges")).toBeTruthy();
  });

  it("encodes provenance: ✓ static, ⚙ framework rule, ✨ + confidence for AI, ×N branches, ↺ recursion", () => {
    const h = openFlow();
    const label = (id: string) => h.container.querySelector(`.edge-label[data-edge-id="${id}"]`)?.textContent;
    expect(label("e-svc-mapper")).toBe("✓");
    expect(label("e-mapper-sql")).toBe("⚙");
    expect(label("e-svc-ext")).toBe("✨ 72%");
    expect(label("e-ctrl-svc")).toBe("✓ · branches ×2");
    expect(label("e-dept-dept")).toContain("↺");
    const aiPath = h.container.querySelector("path.edge-ai-inferred");
    expect(aiPath).not.toBeNull();
    expect(h.container.querySelector(`.edge-label[data-edge-id="e-svc-ext"]`)?.getAttribute("title")).toContain("Rationale: HttpUtils.sendPost");
  });

  it("second implementation is collapsed by default; Space on the caller expands the branch", () => {
    openFlow();
    expect(screen.queryByRole("button", { name: /SysUserCachedServiceImpl/ })).toBeNull();
    const ctrl = node(/^SysUserController\.list,/);
    expect(ctrl.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(ctrl, { key: " " });
    expect(node("SysUserCachedServiceImpl.selectUserList, service layer, 1 outgoing edges")).toBeTruthy();
    expect(node(/^SysUserController\.list,/).getAttribute("aria-expanded")).toBe("true");
  });

  it("clicking a node or pressing Enter posts openSource", () => {
    const h = openFlow();
    fireEvent.click(node(/^SysUserMapper\.selectUserList,/));
    expect(h.lastSent("openSource")?.ref).toMatchObject({ file: expect.stringContaining("SysUserMapper.java"), line: 25 });
    fireEvent.keyDown(node(/^DataScopeAspect.doBefore,/), { key: "Enter" });
    expect(h.lastSent("openSource")?.ref).toMatchObject({ file: expect.stringContaining("DataScopeAspect.java") });
  });

  it("edge context action 标记为错误 posts markEdgeWrong", () => {
    const h = openView("flow", {
      locale: "zh-cn",
      payload: { view: "flow", data: flowListData() },
      persisted: { selectedEntrypointId: USER_LIST_EP },
    });
    h.emit({ type: "flowDetail", data: userListDetail() });
    const edge = h.container.querySelector('.edge-label[data-edge-id="e-svc-ext"]') as HTMLElement;
    fireEvent.contextMenu(edge);
    const menu = screen.getByRole("menu", { name: "边操作" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "标记为错误" }));
    expect(h.lastSent("markEdgeWrong")).toEqual({ type: "markEdgeWrong", edgeId: "e-svc-ext" });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("lists unresolved calls with reason and evidence", () => {
    const h = openFlow();
    const section = h.container.querySelector(".unresolved") as HTMLElement;
    expect(section.textContent).toContain("Unresolved calls (2)");
    expect(section.textContent).toContain("restTemplate.exchange(url, HttpMethod.POST, entity, String.class)");
    expect(section.textContent).toContain("unresolved config value");
  });

  it("collapsing a service band replaces its steps with one placeholder", () => {
    openFlow();
    fireEvent.click(screen.getByRole("button", { name: "Collapse ruoyi-auth" }));
    expect(screen.queryByRole("button", { name: /TokenController\.verify/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Expand ruoyi-auth" })).toBeTruthy();
  });
});

describe("graph keyboard traversal", () => {
  // a → b → c, a → d (siblings b/d)
  const steps: FlowStep[] = ["a", "b", "c", "d"].map((id, i) => ({
    id,
    serviceId: "svc-system",
    layer: (["controller", "service", "repository", "service"] as const)[i] ?? "service",
    symbol: { rootId: "r", file: `${id}.java`, line: 1, name: `N.${id}`, fqn: `N#${id}` },
  }));
  const e = (id: string, from: string, to: string, order: number): CallEdge => ({ id, from, to, order, provenance: "static", confidence: 1 });
  const edges = [e("ab", "a", "b", 0), e("bc", "b", "c", 0), e("ad", "a", "d", 1)];
  const ep = entrypoints[0];
  if (!ep) throw new Error("mock");
  const detail: FlowDetailData = {
    entrypoint: ep,
    flow: { entrypointId: ep.id, stepIds: ["a", "b", "c", "d"], edgeIds: edges.map((x) => x.id), truncated: false },
    steps,
    edges,
    services: serviceRefs,
    unresolvedCalls: [],
  };

  it("Tab stop is the first node; arrows follow edges and siblings", () => {
    openFlow(detail);
    const a = node(/^N\.a,/);
    expect(a.getAttribute("tabindex")).toBe("0");
    expect(node(/^N\.b,/).getAttribute("tabindex")).toBe("-1");
    act(() => a.focus());

    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(document.activeElement).toBe(node(/^N\.b,/));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowRight" });
    expect(document.activeElement).toBe(node(/^N\.c,/));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(node(/^N\.b,/));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement).toBe(node(/^N\.d,/));
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowUp" });
    expect(document.activeElement).toBe(node(/^N\.b,/));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(a);
    expect(a.getAttribute("tabindex")).toBe("0");
  });
});

describe("responsive", () => {
  it("under 600px the entrypoint list becomes a select and the pyramid becomes an indented list", () => {
    window.innerWidth = 480;
    const h = openFlow();
    expect(screen.queryByRole("listbox")).toBeNull();
    const select = screen.getByRole("combobox", { name: "Entrypoint" }) as HTMLSelectElement;
    expect(select.value).toBe(USER_LIST_EP);
    expect(h.container.querySelector(".pyramid.vertical")).not.toBeNull();
    // Edges are listed under each step in vertical mode.
    expect(h.container.querySelector('.vertical-edges .edge-label[data-edge-id="e-svc-ext"]')).not.toBeNull();
  });
});

describe("entrypoint list", () => {
  it("groups by service, filters by search and method, selects with keyboard", () => {
    const h = openView("flow", { payload: { view: "flow", data: flowListData() } });
    const list = screen.getByRole("listbox", { name: "Entrypoint" });
    expect(list.querySelector(".ep-group")?.textContent).toContain("ruoyi-system");

    fireEvent.change(screen.getByRole("combobox", { name: "Method" }), { target: { value: "DELETE" } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "auth" } });
    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["DELETE/auth/logout"]);

    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(h.lastSent("requestFlow")).toEqual({ type: "requestFlow", entrypointId: "ep:DELETE /auth/logout" });
  });

  it("virtualizes long lists (only a window of rows is in the DOM)", () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({
      ...(entrypoints[0] as (typeof entrypoints)[number]),
      id: `ep:${i}`,
      path: `/x/${String(i).padStart(4, "0")}`,
    }));
    openView("flow", { payload: { view: "flow", data: { services: serviceRefs, entrypoints: many } } });
    const rendered = screen.getAllByRole("option").length;
    expect(rendered).toBeGreaterThan(10);
    expect(rendered).toBeLessThan(100);
  });
});
