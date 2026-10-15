// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";
import { openView } from "./helpers.js";
import { overviewData } from "../src/dev/mock.js";
import { langFor, makeT, TABLES } from "../src/i18n.js";

describe("legend", () => {
  it("is reachable from every tab and lists all provenance kinds with line style and mark", () => {
    openView("history");
    fireEvent.click(screen.getByRole("button", { name: "Legend" }));
    const dialog = screen.getByRole("dialog", { name: "Edge provenance" });
    const rows = [...dialog.querySelectorAll("tbody tr")];
    expect(rows.map((r) => r.getAttribute("data-provenance"))).toEqual([
      "static",
      "framework-rule",
      "ai-inferred",
      "runtime-observed",
      "branch",
      "recursion",
    ]);
    const marks = rows.map((r) => r.querySelector(".mark")?.textContent);
    expect(marks).toEqual(["✓", "⚙", "✨ 72%", "●", "×N", "↺"]);
    expect(within(dialog).getByText("dashed")).toBeTruthy();
    expect(within(dialog).getByText("dotted 2px")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("i18n", () => {
  it("zh and en tables define the same keys and no empty strings", () => {
    const en = Object.keys(TABLES.en).sort();
    expect(Object.keys(TABLES.zh).sort()).toEqual(en);
    for (const lang of ["en", "zh"] as const) for (const v of Object.values(TABLES[lang])) expect(v.trim()).not.toBe("");
  });

  it("locale mapping: zh-cn → Chinese, everything else English", () => {
    expect(langFor("zh-cn")).toBe("zh");
    expect(langFor("zh-CN")).toBe("zh");
    expect(langFor("en")).toBe("en");
    expect(langFor("fr")).toBe("en");
    expect(langFor(undefined)).toBe("en");
    expect(makeT("zh")("banner.stale", { n: 4 })).toBe("4 个文件已变化");
  });

  it("renders Chinese UI for zh-cn", () => {
    openView("overview", { locale: "zh-cn", payload: { view: "overview", data: overviewData(true) } });
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["总览", "拓扑", "模块", "功能", "启动", "流转", "修改记录"]);
    expect(screen.getByRole("heading", { name: "这是什么" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "怎么跑" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "重点在哪" })).toBeTruthy();
  });

  it("renders English UI for en", () => {
    openView("overview", { locale: "en", payload: { view: "overview", data: overviewData(true) } });
    expect(screen.getByRole("heading", { name: "What it is" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How to run" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Where the heat is" })).toBeTruthy();
  });
});

describe("overview", () => {
  it("startup commands have copy buttons that post copyText", () => {
    const h = openView("overview", { payload: { view: "overview", data: overviewData(true) } });
    const how = screen.getByRole("region", { name: "How to run" });
    const copy = within(how).getAllByRole("button", { name: /^Copy command: / })[0] as HTMLElement;
    fireEvent.click(copy);
    expect(h.lastSent("copyText")?.text).toBe("mvn -pl ruoyi-modules/ruoyi-system -am clean package -DskipTests");
  });

  it("diagnostics are in a collapsed details element", () => {
    const h = openView("overview", { payload: { view: "overview", data: overviewData(true) } });
    const details = h.container.querySelector("details.diagnostics") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toContain("Diagnostics (2)");
  });
});
