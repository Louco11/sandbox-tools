#!/bin/sh
# Личные ключи MCP (шаг Б2): ключ принадлежит человеку, а не тулу. В базе — только префикс и хэш секрета,
# сам ключ виден один раз при выпуске. Своя схема и своя роль: сервис личности не видит данные источников.
# Идемпотентно: на свежем томе — при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS identity;

CREATE TABLE IF NOT EXISTS identity.keys (
    id           bigserial   PRIMARY KEY,
    owner        text        NOT NULL,              -- логин человека: ключ всегда чей-то
    name         text        NOT NULL,              -- «ноутбук», «Claude Desktop» — чтобы было что отзывать
    prefix       text        NOT NULL UNIQUE,       -- по нему ищем, он же в логах и аудите
    secret_hash  text        NOT NULL,              -- sha256 секрета; самого секрета в базе нет
    created_at   timestamptz NOT NULL DEFAULT now(),
    created_by   text        NOT NULL,              -- человек сам или администратор
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz,
    last_agent   text,
    last_ip      text,
    revoked_at   timestamptz,
    revoked_by   text,
    revoke_reason text
);
CREATE INDEX IF NOT EXISTS keys_owner ON identity.keys (owner);

DO \$\$ BEGIN
  CREATE ROLE identity_service LOGIN PASSWORD '${PG_IDENTITY_PASSWORD}';
EXCEPTION WHEN duplicate_object THEN
  ALTER ROLE identity_service LOGIN PASSWORD '${PG_IDENTITY_PASSWORD}';
END \$\$;

GRANT CONNECT ON DATABASE sources TO identity_service;
GRANT USAGE ON SCHEMA identity TO identity_service;
GRANT SELECT, INSERT, UPDATE ON identity.keys TO identity_service;
GRANT USAGE ON SEQUENCE identity.keys_id_seq TO identity_service;
-- Выпуск, отзыв и вызовы с отозванным ключом — в общий аудит платформы.
GRANT USAGE ON SCHEMA audit TO identity_service;
GRANT INSERT ON audit.calls TO identity_service;
GRANT USAGE ON SEQUENCE audit.calls_id_seq TO identity_service;
SQL
