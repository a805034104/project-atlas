#!/usr/bin/env bash
# Single-node Kafka 4.x in KRaft mode on 127.0.0.1:9092 (no Docker), for the AC#22 Kafka scenario.
# kafka-server-start.bat needs wmic (gone from Windows 11 24H2), so the broker is started with java directly.
#   KAFKA_HOME (default /e/tools/kafka, from kafka_2.13-4.3.1.tgz, sha512-checked), KAFKA_DATA (/e/tools/kafka-data)
set -euo pipefail
KAFKA_HOME="${KAFKA_HOME:-/e/tools/kafka}"
KAFKA_DATA="${KAFKA_DATA:-/e/tools/kafka-data}"
KAFKA_LOGS="${KAFKA_LOGS:-/e/tools/kafka-logs}"
port_open() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }
if port_open 9092; then echo "kafka: already listening on 9092"; exit 0; fi
mkdir -p "$KAFKA_LOGS"
if [ ! -f "$KAFKA_DATA/meta.properties" ]; then
  uuid=$(java -cp "$(cygpath -w "$KAFKA_HOME")/libs/*" kafka.tools.StorageTool random-uuid 2>/dev/null | tail -1 | tr -d '\r')
  java -cp "$(cygpath -w "$KAFKA_HOME")/libs/*" kafka.tools.StorageTool format --standalone -t "$uuid" -c "$(cygpath -w "$KAFKA_HOME")/config/server.properties" >/dev/null
fi
cd "$KAFKA_HOME"
nohup java -Xmx512m -Xms256m "-Dkafka.logs.dir=$(cygpath -w "$KAFKA_LOGS")" -cp "$(cygpath -w "$KAFKA_HOME")/libs/*" kafka.Kafka config/server.properties >"$KAFKA_LOGS/server.out" 2>&1 &
disown || true
for i in $(seq 1 90); do port_open 9092 && { echo "kafka: up"; exit 0; }; sleep 1; done
echo "kafka: failed, see $KAFKA_LOGS/server.out"; exit 1
