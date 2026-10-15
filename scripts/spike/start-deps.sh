#!/usr/bin/env bash
# S0 spike: start portable MySQL 8.0 (127.0.0.1:3306) and Redis 5 (127.0.0.1:6379).
# Paths can be overridden via env. Idempotent: skips a service whose port already answers.
set -euo pipefail
MYSQL_HOME="${MYSQL_HOME:-/e/tools/mysql}"
MYSQL_INI="${MYSQL_INI:-E:/tools/mysql/my.ini}"
REDIS_HOME="${REDIS_HOME:-/e/Redis-x64-5.0.14.1}"
LOG_DIR="${LOG_DIR:-/e/tools/mysql-data}"

port_open() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }

if port_open 3306; then echo "mysql: already listening on 3306"; else
  nohup "$MYSQL_HOME/bin/mysqld" --defaults-file="$MYSQL_INI" >"$LOG_DIR/mysqld.stdout" 2>&1 &
  disown || true
  for i in $(seq 1 60); do port_open 3306 && break; sleep 1; done
  port_open 3306 && echo "mysql: up" || { echo "mysql: failed, see $LOG_DIR/mysqld.err"; exit 1; }
fi

if port_open 6379; then echo "redis: already listening on 6379"; else
  nohup "$REDIS_HOME/redis-server.exe" --port 6379 --bind 127.0.0.1 --save "" --appendonly no >"$LOG_DIR/redis.stdout" 2>&1 &
  disown || true
  for i in $(seq 1 30); do port_open 6379 && break; sleep 1; done
  port_open 6379 && echo "redis: up" || { echo "redis: failed"; exit 1; }
fi
