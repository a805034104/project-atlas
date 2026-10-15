"""Independent reference count of Spring MVC endpoints (method-level mapping
annotations in @Controller/@RestController classes; arrays count per value).
Used to cross-check spec AC#2 on pinned fixtures:
    python scripts/reference/count_spring_endpoints.py fixtures/repos/ruoyi-vue
"""
import glob, io, re, sys

root = sys.argv[1] if len(sys.argv) > 1 else "."
total = 0
for path in glob.glob(f"{root}/**/*.java", recursive=True):
    src = io.open(path, encoding="utf-8", errors="replace").read()
    if not re.search(r"@(Rest)?Controller\b", src):
        continue
    body = src[re.search(r"\bclass\s+\w+", src).end():]
    for m in re.finditer(r"@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(\(([^)]*)\))?", body):
        args = m.group(3) or ""
        values = re.findall(r'"[^"]*"', args.split("method")[0]) if args else []
        total += max(1, len(values)) if "{" in args else 1
print(total)
