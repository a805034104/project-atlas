# Contributing / 贡献指南

The most valuable contribution is a **framework rule**: teaching Atlas a framework idiom it does not understand yet, e.g. a gateway filter, an RPC client, or an in-house annotation that many projects share.

最有价值的贡献是**框架规则**：教 Atlas 认识它还不懂的框架写法，例如某种网关过滤器、RPC 客户端，或很多项目共用的自定义注解。

## Setup

```bash
npm install
npm run fixtures     # clones pinned RuoYi fixtures into fixtures/repos (gitignored)
npx tsc -b && npx vitest run
npm run build -w @project-atlas/webview && npm run build -w project-atlas   # extension bundle
```

## How analysis is layered

```
files ─▶ facts (packages/core/src/facts: tree-sitter → serializable per-file facts, cached)
      ─▶ detection (workspace/detect.ts: services, modules, config views)
      ─▶ rules (rules/spring.ts, rules/vue.ts) ─▶ GraphBuilder steps/edges
      ─▶ cross-service (rules/xservice.ts) ─▶ flows (graph/builder.ts projectFlow)
```

Rules never see syntax trees. They read **facts** (`facts/types.ts`): types, annotations with literal or expression values, fields, methods, locals and call sites. If a new rule needs information that facts do not carry yet, extend the extractor in `facts/java.ts` or `facts/script.ts` and add a facts test first.

规则层不直接接触语法树，只读取 **facts**（见 `facts/types.ts`）：类型、注解及其字面量或表达式值、字段、方法、局部变量、调用点。如果新规则需要 facts 里还没有的信息，先扩展 `facts/java.ts` 或 `facts/script.ts` 的提取器，并先补一个 facts 测试。

## Adding a rule: checklist

1. **Write a minimal fixture first.** Put it under `packages/core/test/rules/fixtures/<name>/`: just the files that show the idiom, a few dozen lines each.
2. **Write a failing test.** Analyze that fixture and assert the flow by **symbol names**, never by line numbers. For example: `filter:XssFilter` comes before `controller:FooController.list`.
3. **Implement the rule** in the matching `rules/*.ts` file. Follow the house rules:
   - **Never guess.** If the receiver type or target is ambiguous, create no edge. Push an `UnresolvedCall`, or create branch edges with a `rationale`.
   - **Choose the right `provenance`.** Use `framework-rule` when framework semantics connect two steps (DI, proxies, routing). Use `static` for plain resolved calls.
   - **Make shared hops per target.** A hop shared by many targets (an aspect, a gateway route) must be a separate step per target. Otherwise traversal fans out to every target.
   - **Unsupported syntax gets a diagnostic.** Use a `ATLAS-Wxxx` code and add it to `docs/errors.md`.
4. **Check real repositories.** Run the RuoYi fixture tests. A rule must not change unrelated flows; review the snapshot diff in your PR.
5. **Document the idiom** in the "Supported" table in both READMEs.

## 添加规则的检查清单

1. **先写一个最小夹具**，放在 `packages/core/test/rules/fixtures/<name>/` 下。只放能体现该写法的文件，每个文件几十行即可。
2. **再写一个会失败的测试**：分析这个夹具，并按**符号名**（不要用行号）断言流转。例如断言 `filter:XssFilter` 出现在 `controller:FooController.list` 之前。
3. **在对应的 `rules/*.ts` 中实现规则**，并遵守以下约定：
   - **宁缺勿错**：接收者类型或调用目标有歧义时，不要建边。改为记一条 `UnresolvedCall`，或者生成带 `rationale` 的分支边。
   - **选对 `provenance`**：靠框架语义连接的两个步骤（依赖注入、代理、路由）用 `framework-rule`；普通的已解析调用用 `static`。
   - **共享环节按目标拆开**：被多个目标共用的环节（切面、网关路由）必须为每个目标单独建一个步骤，否则遍历时会扩散到所有目标。
   - **不支持的写法要报诊断**：使用 `ATLAS-Wxxx` 诊断码，并把它补进 `docs/errors.md`。
4. **用真实仓库检查**：跑一遍若依夹具测试。新规则不能改变无关的流转，提交 PR 时请审阅快照 diff。
5. **更新文档**：在中英文两份 README 的「支持范围」表里补上这种写法。

## Golden files

Expected results are machine-generated snapshots that a human reviews in the PR diff, plus hand-written assertions on seed-fixed samples. Never regenerate a snapshot without reading the diff: that is how analyzer bugs become "expected".

预期结果由机器生成快照，再由人在 PR diff 中审核；另外还有对固定种子抽样的手写断言。不读 diff 就重新生成快照，等于把分析器的 bug 固化成「预期结果」，请不要这样做。

## Commit style

Conventional commits (`feat(core): …`, `fix(webview): …`). Tests must pass: `npx tsc -b && npx vitest run`.
