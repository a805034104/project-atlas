import * as vscode from "vscode";
import path from "node:path";
import type { AtlasGraph, Entrypoint } from "@project-atlas/core";
import type { AtlasController } from "./controller.js";
import { readSettings, t } from "./settings.js";

/** "⟶ 查看请求流转" above every handler that is an entrypoint (spec T5). */

export function entrypointsForFile(graph: AtlasGraph, fsPath: string): Entrypoint[] {
  const normalized = path.resolve(fsPath).toLowerCase();
  const roots = new Map(graph.project.roots.map((r) => [r.id, r.path]));
  return graph.entrypoints.filter((e) => {
    const root = roots.get(e.handler.rootId);
    return root !== undefined && path.resolve(root, e.handler.file).toLowerCase() === normalized && e.kind !== "frontend-route";
  });
}

export class AtlasCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  constructor(private readonly controller: AtlasController) {
    controller.onDidChangeGraph(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const graph = this.controller.graph;
    if (!graph || !readSettings().codeLens) return [];
    const byLine = new Map<number, Entrypoint[]>();
    for (const e of entrypointsForFile(graph, document.uri.fsPath)) {
      const line = Math.max(0, (e.handler.line ?? 1) - 1);
      const list = byLine.get(line);
      if (list) list.push(e);
      else byLine.set(line, [e]);
    }
    const lenses: vscode.CodeLens[] = [];
    for (const [line, eps] of byLine) {
      const range = new vscode.Range(line, 0, line, 0);
      for (const e of eps) {
        const label = e.kind === "http" ? `${e.method} ${e.path}` : e.handler.name;
        lenses.push(new vscode.CodeLens(range, { title: `⟶ ${t("查看请求流转", "Request flow")} · ${label}`, command: "atlas.showFlowForSymbol", arguments: [e.id] }));
      }
    }
    return lenses;
  }
}
