-- «Автопарк» — отдельная система со своей базой: коннектор ходит в неё, а песочница — только в коннектор.
-- Данные выдуманные: машины корпоративного парка и их цена. Роль для чтения — с минимальными грантами.
CREATE SCHEMA IF NOT EXISTS fleet;

CREATE TABLE IF NOT EXISTS fleet.cars (
    id          serial       PRIMARY KEY,
    brand       text         NOT NULL,
    model       text         NOT NULL,
    year        integer      NOT NULL,
    price_rub   integer      NOT NULL,     -- цена по последней оценке
    mileage_km  integer      NOT NULL,
    city        text         NOT NULL,
    status      text         NOT NULL DEFAULT 'in_fleet',   -- in_fleet | for_sale | sold
    updated_at  timestamptz  NOT NULL DEFAULT now()
);

INSERT INTO fleet.cars (brand, model, year, price_rub, mileage_km, city, status) VALUES
  ('Lada',       'Vesta',      2021, 1290000,  48000, 'Москва',          'in_fleet'),
  ('Lada',       'Granta',     2019,  720000, 112000, 'Тверь',           'for_sale'),
  ('Kia',        'Rio',        2020, 1150000,  67000, 'Москва',          'in_fleet'),
  ('Hyundai',    'Solaris',    2018,  890000, 134000, 'Подольск',        'for_sale'),
  ('Skoda',      'Octavia',    2021, 2150000,  39000, 'Москва',          'in_fleet'),
  ('Volkswagen', 'Polo',       2019, 1080000,  88000, 'Тверь',           'in_fleet'),
  ('Toyota',     'Camry',      2022, 3350000,  21000, 'Москва',          'in_fleet'),
  ('Renault',    'Duster',     2017,  830000, 156000, 'Подольск',        'sold'),
  ('Ford',       'Transit',    2020, 2480000,  95000, 'Москва',          'in_fleet'),
  ('GAZ',        'Gazelle Next',2018, 1340000, 178000, 'Тверь',          'for_sale');

-- Коннектор читает под своей ролью: только SELECT и только этой таблицы.
DO $$ BEGIN
  CREATE ROLE cars_read LOGIN PASSWORD 'CARS_READ_PASSWORD_PLACEHOLDER';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT CONNECT ON DATABASE fleet TO cars_read;
GRANT USAGE ON SCHEMA fleet TO cars_read;
GRANT SELECT ON fleet.cars TO cars_read;
