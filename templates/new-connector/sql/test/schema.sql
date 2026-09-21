-- Тестовая схема и данные для проверки коннектора «__TITLE__». Повторяет структуру настоящей базы, но с выдуманными
-- данными. Учётки — как в бою: чтение и запись раздельно, с минимальными грантами.
-- TODO агенту: своя схема, таблицы и роли.
CREATE SCHEMA app;
CREATE TABLE app.items (id serial PRIMARY KEY, name text NOT NULL, status text NOT NULL);
INSERT INTO app.items (name, status) VALUES ('Первая позиция', 'active'), ('Вторая позиция', 'active'), ('Третья позиция', 'archived');

CREATE ROLE connector_read LOGIN PASSWORD 'test';
GRANT USAGE ON SCHEMA app TO connector_read;
GRANT SELECT ON app.items TO connector_read;

CREATE ROLE connector_write LOGIN PASSWORD 'test';
GRANT USAGE ON SCHEMA app TO connector_write;
GRANT SELECT (id), UPDATE (status) ON app.items TO connector_write;
