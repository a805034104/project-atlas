import * as vscode from "vscode";
import { entrypointLabel, type Entrypoint, type Module, type Service } from "@project-atlas/core";
import type { AtlasController } from "./controller.js";
import { t } from "./settings.js";

/**
 * Activity-bar tree: services → (modules, entrypoints by kind). Clicking an
 * entrypoint opens its flow; clicking a module reveals it in the modules view.
 */

type Node =
  | { kind: "service"; service: Service }
  | { kind: "group"; service: Service; group: "modules" | "http" | "routes" | "scheduled" }
  | { kind: "module"; module: Module }
  | { kind: "entrypoint"; entrypoint: Entrypoint };

const ICONS: Record<Service["kind"], string> = { backend: "server-process", gateway: "server-environment", frontend: "browser", worker: "gear" };

export class AtlasTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly controller: AtlasController) {
    controller.onDidChangeGraph(() => this.emitter.fire(undefined));
  }

  getChildren(node?: Node): Node[] {
    const graph = this.controller.graph;
    if (!graph) return [];
    if (!node) return [...graph.services].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map((service) => ({ kind: "service", service }));
    if (node.kind === "service") {
      const groups: Node[] = [];
      const eps = graph.entrypoints.filter((e) => e.serviceId === node.service.id);
      if (graph.modules.some((m) => m.serviceId === node.service.id)) groups.push({ kind: "group", service: node.service, group: "modules" });
      if (eps.some((e) => e.kind === "http")) groups.push({ kind: "group", service: node.service, group: "http" });
      if (eps.some((e) => e.kind === "frontend-route")) groups.push({ kind: "group", service: node.service, group: "routes" });
      if (eps.some((e) => e.kind === "scheduled")) groups.push({ kind: "group", service: node.service, group: "scheduled" });
      return groups;
    }
    if (node.kind === "group") {
      if (node.group === "modules") return graph.modules.filter((m) => m.serviceId === node.service.id).sort((a, b) => a.name.localeCompare(b.name)).map((module) => ({ kind: "module", module }));
      const kind = node.group === "http" ? "http" : node.group === "routes" ? "frontend-route" : "scheduled";
      return graph.entrypoints
        .filter((e) => e.serviceId === node.service.id && e.kind === kind)
        .sort((a, b) => (a.path ?? a.handler.name).localeCompare(b.path ?? b.handler.name))
        .map((entrypoint) => ({ kind: "entrypoint", entrypoint }));
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case "service": {
        const item = new vscode.TreeItem(node.service.name, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(ICONS[node.service.kind]);
        item.description = `${node.service.stack} · ${node.service.kind}`;
        return item;
      }
      case "group": {
        const labels = { modules: t("模块", "Modules"), http: t("HTTP 入口", "HTTP entrypoints"), routes: t("前端路由", "Routes"), scheduled: t("定时任务", "Scheduled") };
        const item = new vscode.TreeItem(labels[node.group], vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.group === "modules" ? "package" : node.group === "routes" ? "link" : node.group === "scheduled" ? "watch" : "symbol-method");
        return item;
      }
      case "module": {
        const item = new vscode.TreeItem(node.module.name, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("symbol-module");
        item.description = `${node.module.fileCount} files`;
        if (node.module.summary) item.tooltip = node.module.summary;
        item.command = { command: "atlas.openPanel", title: "", arguments: [{ view: "modules", nodeId: node.module.id }] };
        return item;
      }
      case "entrypoint": {
        const e = node.entrypoint;
        const item = new vscode.TreeItem(e.kind === "http" ? `${e.method} ${e.path}` : e.kind === "frontend-route" ? (e.path ?? e.handler.name) : e.handler.name, vscode.TreeItemCollapsibleState.None);
        item.description = e.kind === "http" ? e.handler.name : e.handler.name.replace(/^menu /, "");
        item.tooltip = `${entrypointLabel(e)}\n${e.handler.file}:${e.handler.line ?? 1}`;
        item.iconPath = new vscode.ThemeIcon(e.kind === "http" ? "arrow-right" : e.kind === "frontend-route" ? "browser" : "watch");
        item.command = { command: "atlas.showFlowForSymbol", title: "", arguments: [e.id] };
        return item;
      }
    }
  }
}
