#!/usr/bin/env bash
# S0 spike: run RuoYi-Vue with the OpenTelemetry javaagent, fire a fixed request set, wait for spans.
#
#   RUN=A OUT=fixtures/runtime/ruoyi-vue-2.31.1 scripts/spike/run-ruoyi.sh
#
# Env:
#   RUN          label (A|B|C|D|E…), only used for logs
#   MODE         jar (default: java -javaagent … -jar) | mvn (mvn spring-boot:run with run.agents)
#                | jto (java -jar with the agent passed via JAVA_TOOL_OPTIONS)
#                | mvnjto (mvn spring-boot:run with the agent via JAVA_TOOL_OPTIONS; Run C2 contrast)
# Runs used for docs/s0-spike.md: A (default), Araw (PROPS=otel-ruoyi-raw.properties),
#   B (PROPS=runs/otel-ruoyi-B.properties), C (MODE=mvn), C2 (MODE=mvnjto),
#   D1 (AGENT="/e/tools/测试 目录/opentelemetry-javaagent-2.31.1.jar"),
#   E (PROPS=runs/otel-ruoyi-E.properties CTX=/ctx APP_ARGS=--server.servlet.context-path=/ctx),
#   E2 (EXTRA_JVM=-Dotel.semconv-stability.opt-in=database/dup,code/dup). Then: node scripts/spike/decode.mjs <OUT>
#   OUT          capture dir (raw/NNN.pb + requests.jsonl); wiped first
#   PROPS        agent configuration file (default scripts/spike/otel-ruoyi.properties)
#   AGENT        agent jar (default ~/.project-atlas/agents/opentelemetry-javaagent-2.31.1.jar)
#   EXTRA_JVM    extra JVM args (space separated, no spaces inside an arg)
#   APP_ARGS     extra Spring Boot args (e.g. --server.servlet.context-path=/ctx)
#   CTX          context path prefix used by the request set (default empty)
#   RUOYI_DIR    built RuoYi tree (default /e/tools/ruoyi-vue-build)
#   JAVA_HOME    JDK to use (default: java on PATH)
# Requires start-deps.sh to have been run (MySQL 3306 + Redis 6379).
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN="${RUN:-A}"
MODE="${MODE:-jar}"
OUT="$(cd "$ROOT" && mkdir -p "${OUT:-fixtures/runtime/ruoyi-vue-2.31.1}" && cd "${OUT:-fixtures/runtime/ruoyi-vue-2.31.1}" && pwd)"
PROPS="${PROPS:-$ROOT/scripts/spike/otel-ruoyi.properties}"
AGENT="${AGENT:-$HOME/.project-atlas/agents/opentelemetry-javaagent-2.31.1.jar}"
RUOYI_DIR="${RUOYI_DIR:-/e/tools/ruoyi-vue-build}"
CTX="${CTX:-}"
JAVA="${JAVA_HOME:+$JAVA_HOME/bin/}java"
MVN="${MVN:-/e/tools/maven/bin/mvn.cmd}" # mvn.cmd: the sh launcher breaks under MSYS_NO_PATHCONV
BASE="http://127.0.0.1:8080$CTX"
CURL=(curl -s --noproxy '*' --max-time 30)
win() { cygpath -w "$1"; }
# Keep args such as --server.servlet.context-path=/ctx verbatim (Git Bash would rewrite /ctx to C:/Program Files/Git/ctx).
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

port_open() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }
port_open 8080 && { echo "port 8080 busy; stop the previous RuoYi first"; exit 1; }
port_open 43180 && { echo "port 43180 busy; stop the previous capture server first"; exit 1; }

rm -rf "$OUT/raw" "$OUT/requests.jsonl"; mkdir -p "$OUT/raw"
LOG="$OUT/app.log"

node "$(win "$ROOT/scripts/spike/otlp-capture.mjs")" "$(win "$OUT")" 43180 >"$OUT/capture.log" 2>&1 &
CAP_PID=$!
for i in $(seq 1 50); do port_open 43180 && break; sleep 0.2; done

T_START=$(date +%s)
case "$MODE" in
  jar)
    # shellcheck disable=SC2086
    (cd "$RUOYI_DIR/ruoyi-admin" && exec "$JAVA" "-javaagent:$(win "$AGENT")" \
      "-Dotel.javaagent.configuration-file=$(win "$PROPS")" ${EXTRA_JVM:-} \
      -jar target/ruoyi-admin.jar ${APP_ARGS:-}) >"$LOG" 2>&1 &
    ;;
  jto)
    # shellcheck disable=SC2086
    (cd "$RUOYI_DIR/ruoyi-admin" && JAVA_TOOL_OPTIONS="${JTO:-"-javaagent:$(win "$AGENT")"} -Dotel.javaagent.configuration-file=$(win "$PROPS")" \
      exec "$JAVA" ${EXTRA_JVM:-} -jar target/ruoyi-admin.jar ${APP_ARGS:-}) >"$LOG" 2>&1 &
    ;;
  mvn)
    (cd "$RUOYI_DIR/ruoyi-admin" && exec "$MVN" -B -q spring-boot:run \
      "-Dspring-boot.run.agents=$(win "$AGENT")" \
      "-Dspring-boot.run.jvmArguments=-Dotel.javaagent.configuration-file=$(win "$PROPS") ${EXTRA_JVM:-}") >"$LOG" 2>&1 &
    ;;
  mvnjto)
    # Contrast for Run C: agent via JAVA_TOOL_OPTIONS (Maven JVM and forked app JVM both inherit it).
    (cd "$RUOYI_DIR/ruoyi-admin" && JAVA_TOOL_OPTIONS="-javaagent:$(win "$AGENT") -Dotel.javaagent.configuration-file=$(win "$PROPS")" \
      exec "$MVN" -B -q spring-boot:run) >"$LOG" 2>&1 &
    ;;
esac
APP_PID=$!
echo "[$RUN] mode=$MODE app pid=$APP_PID capture pid=$CAP_PID out=$OUT"

# Health: poll until GET / answers 200 (RuoYi index controller), max 240 s.
for i in $(seq 1 480); do
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/" || true)
  [ "$code" = "200" ] && break
  kill -0 $APP_PID 2>/dev/null || { echo "[$RUN] app exited early, see $LOG"; tail -30 "$LOG"; break; }
  sleep 0.5
done
[ "$code" = "200" ] || { echo "[$RUN] not healthy, aborting (see $LOG)"; kill $CAP_PID 2>/dev/null; exit 1; }
echo "[$RUN] healthy after $(( $(date +%s) - T_START )) s (code=$code)"

ts() { date +%s%3N; }
REQ_LOG="$OUT/requests-sent.txt"; : >"$REQ_LOG"
req() { # method path [data] [token]
  local t0; t0=$(ts)
  local args=("${CURL[@]}" -X "$1" "$BASE$2" -H 'Content-Type: application/json')
  [ -n "${3:-}" ] && args+=(--data "$3")
  [ -n "${4:-}" ] && args+=(-H "Authorization: Bearer $4")
  local body; body=$("${args[@]}")
  echo "$t0 $1 $2 -> $(echo "$body" | sed "s/\"token\":\"[^\"]*\"/\"token\":\"<redacted>\"/" | head -c 160)" >>"$REQ_LOG"
  printf '%s' "$body"
}
req GET /captchaImage >/dev/null
TOKEN=$(req POST /login '{"username":"admin","password":"admin123"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || echo "[$RUN] login failed, see $REQ_LOG"
sleep 1 # separate the login trace from the measured request in time
T_REQ=$(ts)
req GET /system/user/list '' "$TOKEN" >/dev/null
req GET /system/role/list '' "$TOKEN" >/dev/null
req GET /monitor/server '' "$TOKEN" >/dev/null
req GET /system/user/1 '' "$TOKEN" >/dev/null
# @Log endpoint: exercises LogAspect + async oper-log insert (AsyncManager thread pool)
req POST '/system/user/export' '' "$TOKEN" >/dev/null

# Wait for span export: poll the raw dir until no new file for 3 s (max 60 s).
last=-1; stable=0
for i in $(seq 1 120); do
  n=$(ls "$OUT/raw" | wc -l)
  if [ "$n" -gt 0 ] && [ "$n" = "$last" ]; then stable=$((stable+1)); else stable=0; fi
  [ "$stable" -ge 6 ] && break
  last=$n; sleep 0.5
done
FIRST_AFTER=$(node -e "
const fs=require('fs');const t=+process.argv[2];
const r=fs.readFileSync(process.argv[1],'utf8').trim().split('\n').map(JSON.parse).find(x=>Date.parse(x.receivedAt)>=t);
console.log(r?(Date.parse(r.receivedAt)-t)+' ms ('+r.file+')':'none')" "$(win "$OUT/requests.jsonl")" "$T_REQ" 2>/dev/null)
echo "[$RUN] captured $(ls "$OUT/raw" | wc -l) payloads; first export after /system/user/list: $FIRST_AFTER"

# Stop the app (whole tree) and the capture server.
stop_port() { # kill the Windows process that listens on a port
  local p; p=$(netstat -ano | awk -v port=":$1" '$2 ~ port"$" && $4=="LISTENING" {print $5; exit}')
  [ -n "$p" ] && taskkill //F //T //PID "$p" >/dev/null 2>&1
}
stop_port 8080; kill $APP_PID 2>/dev/null
if [ "$MODE" = mvn ] || [ "$MODE" = mvnjto ]; then
  for p in $(wmic process where "name='java.exe' and commandline like '%plexus-classworlds%'" get processid 2>/dev/null | tr -dc '0-9\n'); do taskkill //F //T //PID "$p" >/dev/null 2>&1; done
fi
kill $CAP_PID 2>/dev/null; stop_port 43180
grep -n "opentelemetry\|otel\.\|WARN.*io.opentelemetry\|ERROR.*io.opentelemetry" "$LOG" | grep -iv "^.*DEBUG" | head -40 >"$OUT/agent-lines.txt"
echo "[$RUN] done; agent log lines in $OUT/agent-lines.txt"
