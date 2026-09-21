-- Источники данных. Каждая схема — отдельный источник в реестре.

CREATE SCHEMA tasks;
CREATE SCHEMA knowledge;
CREATE SCHEMA audit;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE sources FROM PUBLIC;

-- Задачи ---------------------------------------------------------------

CREATE TABLE tasks.people (
    id    serial PRIMARY KEY,
    name  text NOT NULL UNIQUE,
    role  text NOT NULL,
    team  text NOT NULL
);

CREATE TABLE tasks.tasks (
    id          serial PRIMARY KEY,
    title       text        NOT NULL,
    description text        NOT NULL DEFAULT '',
    status      text        NOT NULL DEFAULT 'todo'
                CHECK (status IN ('inbox', 'todo', 'in_progress', 'waiting', 'done')),
    priority    text        NOT NULL DEFAULT 'normal'
                CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    assignee    text        REFERENCES tasks.people(name),
    project     text        NOT NULL DEFAULT 'Общее',
    due_at      date,
    created_by  text        NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    done_at     timestamptz
);

-- Знания ---------------------------------------------------------------

CREATE TABLE knowledge.notes (
    id          serial PRIMARY KEY,
    task_id     int,                      -- ссылка на tasks.tasks по смыслу, без FK между источниками
    kind        text        NOT NULL CHECK (kind IN ('note', 'decision', 'summary', 'article')),
    title       text        NOT NULL,
    body        text        NOT NULL,
    tags        text        NOT NULL DEFAULT '',   -- через запятую: ищется op=contains
    author      text        NOT NULL,              -- человек, подтвердивший запись
    agent       text,                              -- агент, подготовивший запись, если был
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON tasks.tasks (status);
CREATE INDEX ON tasks.tasks (assignee);
CREATE INDEX ON knowledge.notes (task_id);

-- Audit ----------------------------------------------------------------
-- Заполняет гейтвей (шаг 3). Одна строка — один вызов, включая отказы.

CREATE TABLE audit.calls (
    id             bigserial PRIMARY KEY,
    at             timestamptz NOT NULL DEFAULT now(),
    request_id     text        NOT NULL,
    actor          text        NOT NULL,   -- живой человек
    tool           text        NOT NULL,
    source         text,
    operation      text        NOT NULL,
    fields         text[],
    agent_in_chain boolean     NOT NULL DEFAULT false,
    allowed        boolean     NOT NULL,
    reason         text
);

CREATE INDEX ON audit.calls (tool, at);

-- Gateway state --------------------------------------------------------

CREATE SCHEMA gateway;

-- Тулы, допущенные в контур. Строка появляется только после валидации манифеста против реестра.
CREATE TABLE gateway.tools (
    name          text        PRIMARY KEY,
    owner         text        NOT NULL,
    manifest      jsonb       NOT NULL,
    secret_hash   text        NOT NULL,
    registered_at timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    revoked_at    timestamptz,
    -- Жизненный цикл: последнее явное решение человека о сроке (регистрация или продление),
    -- последний вызов человеком и момент уведомления о простое.
    confirmed_at     timestamptz NOT NULL DEFAULT now(),
    last_human_at    timestamptz,
    idle_notified_at timestamptz,
    idle_revived_at  timestamptz      -- когда простой прервал заход человека: владельцу ещё сутки предлагаем удалить
);

-- Запись в боевую систему в два шага: подготовить (может агент) → подтвердить (только человек).
CREATE TABLE gateway.pending_writes (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tool           text        NOT NULL REFERENCES gateway.tools(name),
    write_id       text        NOT NULL,
    params         jsonb       NOT NULL,
    summary        text        NOT NULL,
    prepared_by    text        NOT NULL,
    agent_in_chain boolean     NOT NULL,
    agent          text,                   -- имя агента, подготовившего запись
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    committed_at   timestamptz,
    committed_by   text
);
