#!/bin/sh
# Источник boards: общие доски тула whiteboard и история их публикаций.
# Скрипт идемпотентный: на свежем томе выполняется при инициализации,
# на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS boards;

CREATE TABLE IF NOT EXISTS boards.boards (
    id          serial PRIMARY KEY,
    name        text        NOT NULL,
    content     jsonb       NOT NULL,             -- элементы холста: {"els": [...]}
    version     int         NOT NULL DEFAULT 1,   -- растёт с каждой публикацией; защита от затирания чужих правок
    created_by  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  text        NOT NULL,             -- человек, подтвердивший последнюю публикацию
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Каждая публикация сохраняется целиком: доску можно откатить, даже если её испортили.
CREATE TABLE IF NOT EXISTS boards.versions (
    board_id  int         NOT NULL REFERENCES boards.boards(id),
    version   int         NOT NULL,
    name      text        NOT NULL,
    content   jsonb       NOT NULL,
    saved_by  text        NOT NULL,
    saved_at  timestamptz NOT NULL DEFAULT now(),
    note      text        NOT NULL DEFAULT '',
    PRIMARY KEY (board_id, version)
);

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_boards_readonly') THEN CREATE ROLE src_boards_readonly LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_boards_create')   THEN CREATE ROLE src_boards_create LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_boards_save')     THEN CREATE ROLE src_boards_save LOGIN; END IF;
END
\$\$;
ALTER ROLE src_boards_readonly PASSWORD '${PG_BOARDS_READONLY_PASSWORD}';
ALTER ROLE src_boards_create   PASSWORD '${PG_BOARDS_CREATE_PASSWORD}';
ALTER ROLE src_boards_save     PASSWORD '${PG_BOARDS_SAVE_PASSWORD}';

GRANT CONNECT ON DATABASE sources TO src_boards_readonly, src_boards_create, src_boards_save;
GRANT USAGE ON SCHEMA boards TO src_boards_readonly, src_boards_create, src_boards_save;

GRANT SELECT ON boards.boards, boards.versions TO src_boards_readonly;

-- boards.board:create — только новая доска и её первая версия. Чужие доски не видит.
GRANT SELECT (id) ON boards.boards TO src_boards_create;
GRANT INSERT (name, content, created_by, updated_by) ON boards.boards TO src_boards_create;
GRANT USAGE ON SEQUENCE boards.boards_id_seq TO src_boards_create;
GRANT INSERT (board_id, version, name, content, saved_by, note) ON boards.versions TO src_boards_create;

-- boards.board:save — новая версия существующей доски. Удалять доски и историю не может.
GRANT SELECT (id, name, content, version, updated_by, updated_at) ON boards.boards TO src_boards_save;
GRANT UPDATE (name, content, version, updated_by, updated_at) ON boards.boards TO src_boards_save;
GRANT INSERT (board_id, version, name, content, saved_by, note) ON boards.versions TO src_boards_save;
SQL
