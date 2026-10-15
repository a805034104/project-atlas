# TODOS

## P2

### ~~MCP server (E4)~~ — moved into v0.1 as child #20 (gate T2, 2026-10-15)
- **What:** Read-only MCP server (`packages/mcp`) serving entrypoints, flows, service links from `.atlas/graph/`.
- **Why:** AI coding agents fabricate call chains; AtlasGraph is verified ground truth they could query.
- **Pros:** Platform leverage; reuses core + graph store. **Cons:** New public interface to version.
- **Context:** Proposed in CEO review 2026-10-15; reviewers disagreed on v0.1 vs later.
- **Effort:** M → CC S. **Depends on:** #1 model, E2 CLI.

### GitHub Action that refreshes ATLAS.md on PR (E7)
- **What:** Action running `npx project-atlas analyze --no-ai` and committing/commenting `ATLAS.md`.
- **Why:** Committed maps spread through repos (distribution channel).
- **Effort:** S → CC S. **Depends on:** E1 export, E2 CLI.

### SCIP index import
- **What:** Accept existing scip-java / scip-go / scip-python indexes to upgrade call-edge precision.
- **Why:** tree-sitter cannot fully resolve receiver types (ENG review).
- **Effort:** M → CC S. **Depends on:** AtlasGraph stable IDs.

### Go toolchain enhancement (go/types)
- **What:** When `go` is installed, resolve interface dispatch via go/packages + go/types.
- **Effort:** M → CC S. **Depends on:** #10.

## Roadmap after v0.1 (U1, 2026-10-15)
- v0.2: local runtime tracing (Java first) + MQ links (Redis Stream, Kafka, RabbitMQ, RocketMQ)
- v0.3: Go rules + Go tracing diff + gRPC
- v0.4: Python rules (pyright LSP) + Python tracing + Dubbo

## P3

### "Ask the map" chat (E3)
- **What:** Q&A over AtlasGraph inside the panel. **Effort:** M → CC S.

### Runtime-loaded third-party rule plugins (E5 remainder)
- **What:** Load community RuleSets from npm at runtime. v0.1 ships in-repo `RuleSet` interface + CONTRIBUTING only.
- **Effort:** M → CC S.

### Opt-in telemetry for TTHW / drop-off
- **What:** Opt-in, anonymous phase timings. Default off forever. **Effort:** S.

### Animated trace replay in flow view
- **What:** Step-through playback of a recorded trace over the swimlane. **Effort:** S.
