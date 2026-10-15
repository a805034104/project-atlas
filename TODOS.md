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

### SkyWalking trace import (v0.2 /autoplan X5, gate T3)
- **What:** Import traces from a running SkyWalking OAP (GraphQL query API) into the v0.2 reconciliation layer.
- **Why:** Many Chinese enterprise Java teams already run SkyWalking; they should not need a second agent.
- **Context:** Reuse the v0.2 internal `SpanRecord` format; SkyWalking segments map to spans (endpoint name ≈ route, component = layer). Needs a live OAP to validate.
- **Effort:** M → CC S. **Depends on:** v0.2 R1/R2.

### Arthas `trace` output import (v0.2 /autoplan X6, gate T3)
- **What:** Parse Arthas `trace` text output into SpanRecords, so a running JVM can be reconciled without restart.
- **Why:** Arthas is the default runtime tool for Chinese Java developers; no restart needed.
- **Context:** Text format varies between Arthas versions; fixture-driven parser.
- **Effort:** M → CC S. **Depends on:** v0.2 R2.

### Docker-hosted services (`trace --listen`)
- **What:** Opt-in receiver bind for `host.docker.internal` with token-only auth.
- **Why:** v0.2 receiver listens on 127.0.0.1 only; services in containers cannot reach it.
- **Effort:** S. **Depends on:** v0.2 R1 security review.

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
