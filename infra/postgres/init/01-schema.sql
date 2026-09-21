-- Платформенные схемы: аудит гейтвея и его собственные таблицы. Источники данных приходят своими
-- сидами и коннекторами — в этом контуре это «Автопарк» (infra/cars-db).

CREATE SCHEMA audit;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE sources FROM PUBLIC;

-- Задачи ---------------------------------------------------------------

-- Знания ---------------------------------------------------------------

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
