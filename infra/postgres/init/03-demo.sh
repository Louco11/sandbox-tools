#!/bin/sh
# Демо-слой: источники, на которых песочницу можно потрогать, ничего не подключая.
# Наливается только при SANDBOX_DEMO=1 (`make demo-on`) — в чистом контуре этих схем нет вовсе.
# Идемпотентно: на живом стенде то же самое делает `make migrate`.
set -eu

if [ "${SANDBOX_DEMO:-0}" != 1 ]; then
  echo "демо-слой выключен (SANDBOX_DEMO=0) — демо-источники не наливаются"
  exit 0
fi

echo "демо-слой включён: наливаю демо-источники"
for f in /demo/*.sql /demo/*.sh; do
  [ -e "$f" ] || continue
  case "$f" in
    *.sql) psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f "$f" >/dev/null ;;
    *.sh)  sh "$f" ;;
  esac
  echo "  ✓ $(basename "$f")"
done
