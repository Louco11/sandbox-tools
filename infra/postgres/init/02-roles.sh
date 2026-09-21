#!/bin/sh
# Одна роль БД на один источник или право записи из реестра.
# Даже если гейтвей ошибётся со скоупом, роль не даст выйти за пределы источника.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL


-- tasks.task:create — только новая задача; существующие не видит и не меняет.
GRANT INSERT (title, description, status, priority, assignee, project, due_at, created_by)

-- tasks.task:update — статус, приоритет, исполнитель, срок. Текст задачи и автора не меняет, удалять не может.

-- knowledge.note:create — только дописывать. Править и удалять знания нельзя.

-- Служебная роль гейтвея: аудит (только дописывать) и собственное состояние. К данным источников доступа нет.
CREATE ROLE gateway_service LOGIN PASSWORD '${PG_GATEWAY_PASSWORD}';
GRANT CONNECT ON DATABASE sources TO gateway_service;
GRANT USAGE ON SCHEMA audit, gateway TO gateway_service;
GRANT INSERT, SELECT ON audit.calls TO gateway_service;
GRANT USAGE ON SEQUENCE audit.calls_id_seq TO gateway_service;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA gateway TO gateway_service;
SQL
