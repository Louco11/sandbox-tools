#!/bin/sh
# Роли демо-источников: одна на источник или право записи. Платформенная роль gateway_service — в init. из реестра.
# Даже если гейтвей ошибётся со скоупом, роль не даст выйти за пределы источника.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE src_tasks_readonly LOGIN PASSWORD '${PG_TASKS_READONLY_PASSWORD}';
GRANT CONNECT ON DATABASE sources TO src_tasks_readonly;
GRANT USAGE ON SCHEMA tasks TO src_tasks_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA tasks TO src_tasks_readonly;

CREATE ROLE src_knowledge_readonly LOGIN PASSWORD '${PG_KNOWLEDGE_READONLY_PASSWORD}';
GRANT CONNECT ON DATABASE sources TO src_knowledge_readonly;
GRANT USAGE ON SCHEMA knowledge TO src_knowledge_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA knowledge TO src_knowledge_readonly;

-- tasks.task:create — только новая задача; существующие не видит и не меняет.
CREATE ROLE src_tasks_create LOGIN PASSWORD '${PG_TASKS_CREATE_PASSWORD}';
GRANT CONNECT ON DATABASE sources TO src_tasks_create;
GRANT USAGE ON SCHEMA tasks TO src_tasks_create;
GRANT SELECT (name) ON tasks.people TO src_tasks_create;
GRANT SELECT (id) ON tasks.tasks TO src_tasks_create;
GRANT INSERT (title, description, status, priority, assignee, project, due_at, created_by)
      ON tasks.tasks TO src_tasks_create;
GRANT USAGE ON SEQUENCE tasks.tasks_id_seq TO src_tasks_create;

-- tasks.task:update — статус, приоритет, исполнитель, срок. Текст задачи и автора не меняет, удалять не может.
CREATE ROLE src_tasks_update LOGIN PASSWORD '${PG_TASKS_UPDATE_PASSWORD}';
GRANT CONNECT ON DATABASE sources TO src_tasks_update;
GRANT USAGE ON SCHEMA tasks TO src_tasks_update;
GRANT SELECT (name) ON tasks.people TO src_tasks_update;
GRANT SELECT (id, title, status, priority, assignee, due_at, done_at) ON tasks.tasks TO src_tasks_update;
GRANT UPDATE (status, priority, assignee, due_at, updated_at, done_at) ON tasks.tasks TO src_tasks_update;

-- knowledge.note:create — только дописывать. Править и удалять знания нельзя.
CREATE ROLE src_knowledge_note_create LOGIN PASSWORD '${PG_KNOWLEDGE_NOTE_CREATE_PASSWORD}';
GRANT CONNECT ON DATABASE sources TO src_knowledge_note_create;
GRANT USAGE ON SCHEMA knowledge TO src_knowledge_note_create;
GRANT SELECT (id) ON knowledge.notes TO src_knowledge_note_create;
GRANT INSERT (task_id, kind, title, body, tags, author, agent) ON knowledge.notes TO src_knowledge_note_create;
GRANT USAGE ON SEQUENCE knowledge.notes_id_seq TO src_knowledge_note_create;

-- Служебная роль гейтвея: аудит (только дописывать) и собственное состояние. К данным источников доступа нет.
SQL
