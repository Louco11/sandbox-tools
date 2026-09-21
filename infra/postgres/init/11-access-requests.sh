#!/bin/sh
# Заявки на доступ к тулу (П1): заявка — объект, а не только письмо. Владелец закрывает её одной кнопкой,
# проситель видит ответ. История остаётся: кто просил, когда, что решили.
# Идемпотентно: на свежем томе — при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE TABLE IF NOT EXISTS gateway.access_requests (
    id         bigserial   PRIMARY KEY,
    tool       text        NOT NULL,
    login      text        NOT NULL,
    note       text,
    created_at timestamptz NOT NULL DEFAULT now(),
    status     text        NOT NULL DEFAULT 'pending',   -- pending | granted | denied
    decided_by text,
    decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS access_requests_pending ON gateway.access_requests (tool, login) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS access_requests_tool ON gateway.access_requests (tool, status);

GRANT SELECT, INSERT, UPDATE ON gateway.access_requests TO gateway_service;
GRANT USAGE ON SEQUENCE gateway.access_requests_id_seq TO gateway_service;
SQL
