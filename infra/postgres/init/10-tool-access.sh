#!/bin/sh
# Кому доступен тул (шаг Б4). Источник правды — база, а не манифест: доступ меняют на главной без передеплоя.
# Манифест задаёт начальное значение при первом допуске тула.
# Идемпотентно: на свежем томе — при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE TABLE IF NOT EXISTS gateway.tool_access (
    tool       text        PRIMARY KEY,          -- имя тула, а не инстанса: превью наследуют доступ прода
    groups     text[]      NOT NULL DEFAULT '{}',
    people     text[]      NOT NULL DEFAULT '{}',-- исключения: подрядчик, стажёр
    agents     boolean     NOT NULL DEFAULT true,-- можно ли подключать тул агентом (MCP)
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text        NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON gateway.tool_access TO gateway_service;
SQL
