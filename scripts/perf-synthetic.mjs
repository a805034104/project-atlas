// AC-PERF: generate a synthetic Spring + MyBatis repository with N Java files
// and check the deterministic analysis stays within the time and memory budget.
//   node scripts/perf-synthetic.mjs --files 50000 --budget-ms 90000 --budget-mb 1536
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeWorkspace } from "../packages/core/dist/index.js";

const { values } = parseArgs({
  options: {
    files: { type: "string", default: "50000" },
    "budget-ms": { type: "string", default: "90000" },
    "budget-mb": { type: "string", default: "1536" },
    keep: { type: "boolean", default: false },
  },
});
const total = Number(values.files);
const perModule = 500;
const modules = Math.max(1, Math.ceil(total / perModule / 3));
const root = mkdtempSync(path.join(tmpdir(), "atlas-perf-"));

const write = (rel, text) => {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

write("pom.xml", `<project><groupId>demo</groupId><artifactId>demo-parent</artifactId><packaging>pom</packaging><modules>${Array.from({ length: modules }, (_, m) => `<module>mod${m}</module>`).join("")}<module>app</module></modules></project>`);
write("app/pom.xml", `<project><groupId>demo</groupId><artifactId>app</artifactId><dependencies>${Array.from({ length: modules }, (_, m) => `<dependency><groupId>demo</groupId><artifactId>mod${m}</artifactId></dependency>`).join("")}</dependencies><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>`);
write("app/src/main/java/demo/App.java", "package demo;\n@SpringBootApplication\npublic class App { public static void main(String[] a) { SpringApplication.run(App.class, a); } }\n");
write("app/src/main/resources/application.yml", "server:\n  port: 8080\nspring:\n  application:\n    name: demo\n");

let count = 0;
for (let m = 0; m < modules && count < total; m++) {
  write(`mod${m}/pom.xml`, `<project><groupId>demo</groupId><artifactId>mod${m}</artifactId></project>`);
  const pkg = `demo.mod${m}`;
  const dir = `mod${m}/src/main/java/demo/mod${m}`;
  for (let i = 0; i < perModule && count < total; i++, count += 3) {
    write(`${dir}/controller/C${i}Controller.java`, `package ${pkg}.controller;
import ${pkg}.service.IS${i}Service;
@RestController
@RequestMapping("/m${m}/c${i}")
public class C${i}Controller {
  @Autowired private IS${i}Service service;
  @GetMapping("/list") public Object list(String q) { return service.list(q); }
  @PostMapping public Object add(@RequestBody Object body) { return service.add(body); }
  @GetMapping("/{id}") public Object get(@PathVariable Long id) { return service.get(id); }
}
`);
    write(`${dir}/service/IS${i}Service.java`, `package ${pkg}.service;
public interface IS${i}Service { Object list(String q); Object add(Object b); Object get(Long id); }
`);
    write(`${dir}/service/impl/S${i}ServiceImpl.java`, `package ${pkg}.service.impl;
import ${pkg}.service.IS${i}Service;
import ${pkg}.mapper.M${i}Mapper;
@Service
public class S${i}ServiceImpl implements IS${i}Service {
  @Autowired private M${i}Mapper mapper;
  public Object list(String q) { return mapper.selectList(q); }
  public Object add(Object b) { return mapper.insert(b); }
  public Object get(Long id) { return mapper.selectById(id); }
}
`);
    write(`${dir}/mapper/M${i}Mapper.java`, `package ${pkg}.mapper;
@Mapper
public interface M${i}Mapper { Object selectList(String q); int insert(Object b); Object selectById(Long id); }
`);
  }
}

let peak = 0;
const sampler = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 100);
const started = Date.now();
const { graph } = await analyzeWorkspace({ roots: [{ path: root }], history: false });
const elapsed = Date.now() - started;
clearInterval(sampler);
peak = Math.max(peak, process.memoryUsage().rss);

const mb = Math.round(peak / 1024 / 1024);
console.log(JSON.stringify({ javaFiles: count + 1, elapsedMs: elapsed, peakRssMb: mb, entrypoints: graph.entrypoints.length, steps: graph.steps.length, flows: graph.flows.length }));
if (!values.keep) rmSync(root, { recursive: true, force: true });
const budgetMs = Number(values["budget-ms"]);
const budgetMb = Number(values["budget-mb"]);
if (elapsed > budgetMs || mb > budgetMb) {
  console.error(`AC-PERF failed: ${elapsed} ms (budget ${budgetMs}), ${mb} MB (budget ${budgetMb})`);
  process.exit(1);
}
