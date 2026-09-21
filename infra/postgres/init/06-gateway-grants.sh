#!/bin/sh
# Гейтвей удаляет строки тулов, отозванных или истёкших больше недели назад (уборка истории; аудит остаётся).
# Идемпотентно: на свежем томе выполняется при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
GRANT DELETE ON gateway.tools, gateway.pending_writes TO gateway_service;
SQL
