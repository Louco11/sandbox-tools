#!/bin/sh
# Токены агента в Gitea (шаг Б6): у каждого человека свой бот <логин>-agent, и токен этого бота живёт часы,
# а не вечно. Здесь — только учёт: кому выдан, когда истекает, какой id токена удалять. Сам токен не хранится.
# Идемпотентно: на свежем томе — при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.forge_tokens (
    id         bigserial   PRIMARY KEY,
    owner      text        NOT NULL,              -- человек, от имени которого работает агент
    bot        text        NOT NULL,              -- его бот в Gitea: <логин>-agent
    token_id   bigint      NOT NULL,              -- id токена в Gitea — по нему удаляем
    token_name text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS forge_tokens_owner ON identity.forge_tokens (owner) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON identity.forge_tokens TO identity_service;
GRANT USAGE ON SEQUENCE identity.forge_tokens_id_seq TO identity_service;
SQL
