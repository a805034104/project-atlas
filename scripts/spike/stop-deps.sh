#!/usr/bin/env bash
# S0 spike: stop MySQL and Redis started by start-deps.sh.
MYSQL_HOME="${MYSQL_HOME:-/e/tools/mysql}"
REDIS_HOME="${REDIS_HOME:-/e/Redis-x64-5.0.14.1}"
"$MYSQL_HOME/bin/mysqladmin" -uroot -ppassword -h127.0.0.1 -P3306 shutdown 2>/dev/null \
  || "$MYSQL_HOME/bin/mysqladmin" -uroot -h127.0.0.1 -P3306 shutdown 2>/dev/null \
  || echo "mysql: not running or shutdown failed"
"$REDIS_HOME/redis-cli.exe" -h 127.0.0.1 -p 6379 shutdown nosave 2>/dev/null || echo "redis: not running"
echo "done"
