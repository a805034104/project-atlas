# Changelog

## 0.1.0 — 2026-10-15

First release. Scope per docs/spec.md "范围裁决 v1.2".

- Deterministic project map for Java Spring + Vue (no AI key needed): services, modules, entrypoints,
  request flows (filters → interceptors → @PreAuthorize → aspects → controller → service → mapper → SQL),
  startup guides with file:line evidence, per-module git history.
- Cross-service links: dev proxy → Spring Cloud Gateway (StripPrefix, RewritePath, PrefixPath,
  default-filters, GlobalFilters) → service; OpenFeign; RestTemplate/WebClient; Nacos configs from SQL dumps
  (shared/extension configs, spring.config.import).
- Optional BYO-key AI (Anthropic, OpenAI-compatible, Ollama): module summaries, feature list, change summaries;
  per-phase cost confirmation, secret redaction, evidence check, input-hash cache. Disabled in Restricted Mode.
- VS Code extension: Atlas panel (overview, topology, modules, features, startup, flow swimlane, history),
  activity-bar tree, CodeLens, walkthrough, "mark edge as wrong" → .atlas/overrides.yaml, HTML/ATLAS.md export,
  diagnostics bundle. atlas.yaml v1 (services incl. hardened shallow clones, wrappers, edges, ignoreEntrypoints).
- CLI `project-atlas analyze|show|estimate`, read-only MCP server `atlas-mcp`.
- Verified: RuoYi-Vue 148/148 and RuoYi-Cloud 137/137 endpoints; 50k-file synthetic repo in ~30 s / <700 MB;
  E2E in VS Code (no-key map in ~5 s).
