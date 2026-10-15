# Held-out evaluation (AC-HO)

Repositories the rules were **not** developed against, analyzed with zero configuration and no AI (2026-10-15, shallow clones of the default branch).
Purpose: robustness (no crashes, sane coverage) and recall gaps. **The precision gate (≥95% of deterministic edges correct, human-graded on a seed-fixed sample) is still pending a human reviewer** — see "How to grade" below.

| Repos | Time | Services | HTTP entrypoints | Flows reaching a service | Flows reaching data layer | Cross-service links | Unresolved calls |
|---|---|---|---|---|---|---|---|
| pig,pig-ui | 1.4 s | 8 | 593 | 564/593 | 66/593 | frontend-proxy 224, gateway-route 224, http 26 | unknown-receiver 10, unresolved-config 16 |
| mall-swarm | 0.9 s | 7 | 245 | 243/245 | 229/245 | http 7 | unknown-receiver 9, dynamic-dispatch 20 |
| jeecgboot | 6.4 s | 11 | 1933 | 1635/1933 | 695/1933 | frontend-proxy 283, http 2 | unknown-receiver 651, unresolved-config 171 |

Notes:
- **pig**: most service methods are inherited from MyBatis-Plus `ServiceImpl`, shown as `Xxx.list (ServiceImpl)` steps; the data layer behind them is a library and is not drawn. pig's gateway strips the route prefix in Java code (`PigRequestGlobalFilter`), so the final hop to the backend is shown as an **inferred** edge (dashed, confidence 0.6) with the reason.
- **JeecgBoot**: ~650 unknown receivers are injected interfaces whose type lives in published jars with no implementation in the repository; they are listed under "Unresolved calls" instead of being guessed. The frontend uses `defHttp.get({ url: Api.x })` with TypeScript enums and a vben `VITE_PROXY`; both are supported.
- **mall-swarm**: Spring Cloud 2025 gateway naming (`spring-cloud-starter-gateway-server-webflux`, `spring.cloud.gateway.server.webflux.routes`) is supported; the admin frontend is a separate repository and was not included.

Fixes made from this run: Maven `@token@` filtering, Spring Cloud 2025 gateway keys, `spring.config.import: nacos:` data ids, gateway `default-filters`, MyBatis-Plus inherited mapper/service methods, external interfaces implemented in the project, `/@/` alias, `defHttp`-style clients, TS enum URLs, `env.X` from `loadEnv`, vben `VITE_PROXY`, proxy target context paths, `export default <identifier>`.

## How to grade (human)

```bash
node scripts/heldout-report.mjs fixtures/repos/heldout/pig,fixtures/repos/heldout/pig-ui
npx project-atlas analyze fixtures/repos/heldout/pig fixtures/repos/heldout/pig-ui --no-ai
npx project-atlas show "GET /admin/user/page" --dir fixtures/repos/heldout/pig/.atlas
```

Sample 20 HTTP entrypoints per repository with a fixed seed, open each flow, and mark every solid (static / framework-rule) edge correct or wrong against the source. Gate: ≥95% correct. Record results in this file.
