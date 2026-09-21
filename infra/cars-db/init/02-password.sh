#!/bin/sh
# Пароль роли чтения приходит из окружения: в репозитории его нет.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "ALTER ROLE cars_read LOGIN PASSWORD '${CARS_READ_PASSWORD}'"
