-- Тестовая система для проверки коннектора «Автопарк»: та же форма, что в настоящей базе, данные выдуманные.
-- Учётка как в бою: только чтение и только этой таблицы.
CREATE SCHEMA fleet;
CREATE TABLE fleet.cars (
    id         serial      PRIMARY KEY,
    brand      text        NOT NULL,
    model      text        NOT NULL,
    year       integer     NOT NULL,
    price_rub  integer     NOT NULL,
    mileage_km integer     NOT NULL,
    city       text        NOT NULL,
    status     text        NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fleet.cars (brand, model, year, price_rub, mileage_km, city, status) VALUES
  ('Тестовая марка', 'Первая',  2020, 1000000, 50000, 'Город-1', 'in_fleet'),
  ('Тестовая марка', 'Вторая',  2018,  600000, 120000, 'Город-2', 'for_sale'),
  ('Другая марка',   'Третья',  2022, 2500000, 10000, 'Город-1', 'sold');

CREATE ROLE connector_read LOGIN PASSWORD 'test';
GRANT USAGE ON SCHEMA fleet TO connector_read;
GRANT SELECT ON fleet.cars TO connector_read;
