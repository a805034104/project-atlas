import { describe, expect, it } from "vitest";
import { emptyGraph, loadGraph } from "../../src/model/schema.js";
import { SCHEMA_VERSION } from "../../src/model/types.js";

const analyzedAt = new Date("2026-10-15T14:00:00Z");

describe("loadGraph", () => {
  it("round-trips an empty graph", () => {
    const graph = emptyGraph("0.1.0", "ruoyi", analyzedAt);
    const result = loadGraph(JSON.stringify(graph));
    expect(result).toEqual({ status: "ok", graph });
  });

  it("stores analyzedAt in UTC", () => {
    expect(emptyGraph("0.1.0", "x", analyzedAt).project.analyzedAt).toBe("2026-10-15T14:00:00.000Z");
  });

  it("asks for rebuild on invalid JSON", () => {
    const result = loadGraph("{not json");
    expect(result.status).toBe("rebuild");
    if (result.status === "rebuild") expect(result.reason).toBe("corrupt");
  });

  it.each([
    ["null", "null"],
    ["array", "[]"],
    ["missing version", JSON.stringify({ analyzerVersion: "x" })],
    ["string version", JSON.stringify({ schemaVersion: "1" })],
    ["zero version", JSON.stringify({ schemaVersion: 0 })],
    ["fractional version", JSON.stringify({ schemaVersion: 1.5 })],
  ])("treats %s as corrupt", (_label, raw) => {
    const result = loadGraph(raw);
    expect(result).toMatchObject({ status: "rebuild", reason: "corrupt" });
  });

  it("asks for rebuild when the graph comes from a newer extension", () => {
    const graph = { ...emptyGraph("9.0.0", "x", analyzedAt), schemaVersion: SCHEMA_VERSION + 1 };
    expect(loadGraph(JSON.stringify(graph))).toMatchObject({ status: "rebuild", reason: "newer-schema" });
  });

  it("detects missing collections", () => {
    const { edges: _dropped, ...partial } = emptyGraph("0.1.0", "x", analyzedAt);
    expect(loadGraph(JSON.stringify(partial))).toMatchObject({
      status: "rebuild",
      reason: "corrupt",
      detail: "missing array: edges",
    });
  });

  it("detects missing project roots", () => {
    const graph = { ...emptyGraph("0.1.0", "x", analyzedAt), project: { name: "x" } };
    expect(loadGraph(JSON.stringify(graph))).toMatchObject({ detail: "missing project.roots" });
  });
});
