#!/bin/sh
# Группы песочницы (шаг Б3): их заводит администратор под задачу — «Кондитерская — склад», «Пилот продаж».
# Группы из IdP сюда не копируются: они приходят в личности человека и живут в IdP.
# Идемпотентно: на свежем томе — при инициализации, на живом стенде — через `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE TABLE IF NOT EXISTS gateway.groups (
    name       text        PRIMARY KEY,
    title      text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    created_by text        NOT NULL
);

CREATE TABLE IF NOT EXISTS gateway.group_members (
    group_name text        NOT NULL REFERENCES gateway.groups(name) ON DELETE CASCADE,
    login      text        NOT NULL,
    added_at   timestamptz NOT NULL DEFAULT now(),
    added_by   text        NOT NULL,
    expires_at timestamptz,                       -- участие до конца пилота; NULL — бессрочно
    PRIMARY KEY (group_name, login)
);
CREATE INDEX IF NOT EXISTS group_members_login ON gateway.group_members (login);

GRANT SELECT, INSERT, UPDATE, DELETE ON gateway.groups, gateway.group_members TO gateway_service;
SQL
