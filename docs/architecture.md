# Architecture

```
packages/
  core/      analysis engine (pure Node, no vscode API)
    ingest/     walker (.gitignore/.atlasignore), encoding (UTF-8/BOM/GBK), file kinds
    parse/      web-tree-sitter (WASM) grammars, worker_threads pool, extract → facts
    facts/      serializable per-file facts (Java types/annotations/calls; JS/TS/Vue imports/functions/routes)
    workspace/  load (facts cache .atlas/facts), Maven POMs, service + module detection, config views
    config/     YAML/properties/.env/Nacos SQL dump sources, layered resolver (${a:${b}}, profiles, relaxed binding)
    rules/      java-index (types, DI, constants), spring, vue, xservice, mybatis, ant, pointcut, startup
    graph/      GraphBuilder: global steps/edges with stable ids, per-entrypoint chains, flow projection
    overrides/  atlas.yaml v1 + .atlas/overrides.yaml
    git/        per-module history (git log --numstat -z per pathspec)
    llm/        providers, retry, budget, redaction, prompts, validation, cache, map-reduce pipeline
    store/      sharded graph persistence + view slicing (protocol payloads)
    runtime/    OTLP receiver + decoder, whitelisted span records, aggregates, trace store, reconcile overlay,
                javaagent fetch / config / per-launcher injection (v0.2, see runtime-tracing.md)
    analyze.ts  deterministic orchestrator     enrich.ts  AI enrichment (hub files, estimate, merge)
    protocol.ts host ⇄ webview message contract
  webview/   React + @xyflow/react + elkjs (ELK in a blob Web Worker), VS Code theme tokens only
  vscode/    extension host: commands, TreeView, CodeLens, panel, SecretStorage, cost dialog, exports
  cli/       `project-atlas analyze|show|estimate`
  mcp/       read-only MCP server over .atlas/graph
```

## Data flow

```
workspace folders ─▶ walk ─▶ read+hash ─▶ facts (cache hit? skip parse) ─▶ detect ─▶ rules ─▶ cross-service
   ─▶ overrides ─▶ flows ─▶ git history ─▶ startup ─▶ AtlasGraph ─▶ .atlas/graph (sharded)
   ─(AI configured + user confirmed)▶ hub files ─▶ redact ─▶ LLM (cached by input hash) ─▶ evidence check ─▶ merge
```

Runtime (v0.2):

```
JVM + javaagent ─OTLP/HTTP─▶ receiver (127.0.0.1, token) ─▶ decode ─▶ SpanRecord whitelist ─┬▶ .atlas/traces (raw, 7 d / 100k)
                                                                                         └▶ Aggregator ─▶ reconcile ─▶ overlay on views
```

The overlay is applied when a view is built; the saved graph is never modified.

## Invariants

- **Stable IDs** = `base32(sha1(kind \0 service \0 canonicalKey))[0..16]`. Line numbers are never part of the key.
- **Chain edges** (filters → interceptors → security → aspects → handler, plus the frontend/gateway prefix) carry `chain: true` and are never traversed. Call edges are traversed by flow projection (depth 12, cycle-safe).
- **One step per join point.** Hops shared across targets (aspects, gateway routes and filters) get one step per target, so a projection never fans out.
- **Precision over recall.** Ambiguous receivers become `UnresolvedCall`s, never guessed edges.
- **Cache keys**: facts = content hash + analyzer version. LLM = phase + input hash + analyzer version + prompt version + model + language. Module summaries are keyed on child *input* hashes, so nondeterministic model output never cascades.
- **Security**: code is passed to the LLM only as wrapped untrusted data. The model has no tools. IDs in model output must exist. `.env`/keys are never sent. The webview runs under a strict CSP (nonce scripts, `worker-src blob:`). Restricted Mode disables cloning.
