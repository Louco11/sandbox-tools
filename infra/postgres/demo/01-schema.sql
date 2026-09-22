-- Демо-источники: задачи и знания. Применяются только при включённом демо-слое (SANDBOX_DEMO=1).

CREATE SCHEMA tasks;
CREATE SCHEMA knowledge;

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

-- Gateway state --------------------------------------------------------

-- Запись в боевую систему в два шага: подготовить (может агент) → подтвердить (только человек).
