#!/bin/sh
# История жизней тулов — для метрик выживаемости (шаг А5). Уборщик убирает строки умерших тулов из gateway.tools через
# неделю; перед удалением гейтвей переносит сюда, когда тул родился, когда и почему закончился. Только дописывается.
# Идемпотентно: на свежем томе выполняется при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE TABLE IF NOT EXISTS gateway.tool_history (
    id            bigserial   PRIMARY KEY,
    name          text        NOT NULL,
    owner         text        NOT NULL,
    manifest      jsonb       NOT NULL,
    born_at       timestamptz NOT NULL,
    ended_at      timestamptz NOT NULL,
    end_reason    text        NOT NULL,   -- revoked | idle | expired
    last_human_at timestamptz,
    archived_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_history_name ON gateway.tool_history (name);
GRANT SELECT, INSERT ON gateway.tool_history TO gateway_service;
GRANT USAGE ON SEQUENCE gateway.tool_history_id_seq TO gateway_service;
SQL
