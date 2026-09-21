#!/bin/sh
# Источник pastry: CRM и склад кондитера (клиенты, заказы, рецепты, остатки).
# Скрипт идемпотентный: на свежем томе — при инициализации, на живом стенде — `make migrate`.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE SCHEMA IF NOT EXISTS pastry;

CREATE TABLE IF NOT EXISTS pastry.clients (
    id         serial PRIMARY KEY,
    name       text        NOT NULL,
    phone      text        NOT NULL DEFAULT '',
    email      text        NOT NULL DEFAULT '',
    notes      text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pastry.ingredients (
    id            serial PRIMARY KEY,
    name          text        NOT NULL UNIQUE,
    unit          text        NOT NULL CHECK (unit IN ('g', 'ml', 'pcs')),
    stock_qty     integer     NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
    low_threshold integer     NOT NULL DEFAULT 0 CHECK (low_threshold >= 0),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pastry.cake_types (
    id           serial PRIMARY KEY,
    name         text        NOT NULL UNIQUE,
    price_per_kg integer     NOT NULL CHECK (price_per_kg >= 0),
    active       boolean     NOT NULL DEFAULT true,
    notes        text        NOT NULL DEFAULT '',
    created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pastry.recipe_lines (
    cake_type_id  integer NOT NULL REFERENCES pastry.cake_types(id),
    ingredient_id integer NOT NULL REFERENCES pastry.ingredients(id),
    qty_per_kg    integer NOT NULL CHECK (qty_per_kg > 0),
    PRIMARY KEY (cake_type_id, ingredient_id)
);

CREATE TABLE IF NOT EXISTS pastry.orders (
    id             serial PRIMARY KEY,
    client_id      integer     NOT NULL REFERENCES pastry.clients(id),
    cake_type_id   integer     NOT NULL REFERENCES pastry.cake_types(id),
    weight_g       integer     NOT NULL CHECK (weight_g > 0),
    status         text        NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'confirmed', 'baking', 'ready', 'delivered', 'cancelled')),
    ordered_at     date        NOT NULL DEFAULT current_date,
    due_at         date        NOT NULL,
    due_time       text        NOT NULL DEFAULT '',
    price_rub      integer     NOT NULL CHECK (price_rub >= 0),
    prepaid_rub    integer     NOT NULL DEFAULT 0 CHECK (prepaid_rub >= 0),
    comment        text        NOT NULL DEFAULT '',
    stock_deducted boolean     NOT NULL DEFAULT false,
    created_by     text        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pastry.stock_moves (
    id            bigserial PRIMARY KEY,
    ingredient_id integer     NOT NULL REFERENCES pastry.ingredients(id),
    qty_delta     integer     NOT NULL,
    reason        text        NOT NULL CHECK (reason IN ('receive', 'adjust', 'bake')),
    order_id      integer     REFERENCES pastry.orders(id),
    note          text        NOT NULL DEFAULT '',
    decided_by    text        NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pastry_orders_due_at ON pastry.orders (due_at);
CREATE INDEX IF NOT EXISTS pastry_orders_status ON pastry.orders (status);
CREATE INDEX IF NOT EXISTS pastry_orders_client ON pastry.orders (client_id);
CREATE INDEX IF NOT EXISTS pastry_stock_moves_ingredient ON pastry.stock_moves (ingredient_id);

DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_readonly') THEN CREATE ROLE src_pastry_readonly LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_client_create') THEN CREATE ROLE src_pastry_client_create LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_client_update') THEN CREATE ROLE src_pastry_client_update LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_cake_type_create') THEN CREATE ROLE src_pastry_cake_type_create LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_cake_type_update') THEN CREATE ROLE src_pastry_cake_type_update LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_recipe_upsert') THEN CREATE ROLE src_pastry_recipe_upsert LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_recipe_delete') THEN CREATE ROLE src_pastry_recipe_delete LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_ingredient_create') THEN CREATE ROLE src_pastry_ingredient_create LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_ingredient_update') THEN CREATE ROLE src_pastry_ingredient_update LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_stock_receive') THEN CREATE ROLE src_pastry_stock_receive LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_stock_adjust') THEN CREATE ROLE src_pastry_stock_adjust LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_order_create') THEN CREATE ROLE src_pastry_order_create LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_order_update') THEN CREATE ROLE src_pastry_order_update LOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'src_pastry_order_start_baking') THEN CREATE ROLE src_pastry_order_start_baking LOGIN; END IF;
END
\$\$;

ALTER ROLE src_pastry_readonly PASSWORD '${PG_PASTRY_READONLY_PASSWORD}';
ALTER ROLE src_pastry_client_create PASSWORD '${PG_PASTRY_CLIENT_CREATE_PASSWORD}';
ALTER ROLE src_pastry_client_update PASSWORD '${PG_PASTRY_CLIENT_UPDATE_PASSWORD}';
ALTER ROLE src_pastry_cake_type_create PASSWORD '${PG_PASTRY_CAKE_TYPE_CREATE_PASSWORD}';
ALTER ROLE src_pastry_cake_type_update PASSWORD '${PG_PASTRY_CAKE_TYPE_UPDATE_PASSWORD}';
ALTER ROLE src_pastry_recipe_upsert PASSWORD '${PG_PASTRY_RECIPE_UPSERT_PASSWORD}';
ALTER ROLE src_pastry_recipe_delete PASSWORD '${PG_PASTRY_RECIPE_DELETE_PASSWORD}';
ALTER ROLE src_pastry_ingredient_create PASSWORD '${PG_PASTRY_INGREDIENT_CREATE_PASSWORD}';
ALTER ROLE src_pastry_ingredient_update PASSWORD '${PG_PASTRY_INGREDIENT_UPDATE_PASSWORD}';
ALTER ROLE src_pastry_stock_receive PASSWORD '${PG_PASTRY_STOCK_RECEIVE_PASSWORD}';
ALTER ROLE src_pastry_stock_adjust PASSWORD '${PG_PASTRY_STOCK_ADJUST_PASSWORD}';
ALTER ROLE src_pastry_order_create PASSWORD '${PG_PASTRY_ORDER_CREATE_PASSWORD}';
ALTER ROLE src_pastry_order_update PASSWORD '${PG_PASTRY_ORDER_UPDATE_PASSWORD}';
ALTER ROLE src_pastry_order_start_baking PASSWORD '${PG_PASTRY_ORDER_START_BAKING_PASSWORD}';

GRANT CONNECT ON DATABASE sources TO
  src_pastry_readonly, src_pastry_client_create, src_pastry_client_update,
  src_pastry_cake_type_create, src_pastry_cake_type_update,
  src_pastry_recipe_upsert, src_pastry_recipe_delete,
  src_pastry_ingredient_create, src_pastry_ingredient_update,
  src_pastry_stock_receive, src_pastry_stock_adjust,
  src_pastry_order_create, src_pastry_order_update, src_pastry_order_start_baking;

GRANT USAGE ON SCHEMA pastry TO
  src_pastry_readonly, src_pastry_client_create, src_pastry_client_update,
  src_pastry_cake_type_create, src_pastry_cake_type_update,
  src_pastry_recipe_upsert, src_pastry_recipe_delete,
  src_pastry_ingredient_create, src_pastry_ingredient_update,
  src_pastry_stock_receive, src_pastry_stock_adjust,
  src_pastry_order_create, src_pastry_order_update, src_pastry_order_start_baking;

GRANT SELECT ON ALL TABLES IN SCHEMA pastry TO src_pastry_readonly;

-- clients
GRANT SELECT (id) ON pastry.clients TO src_pastry_client_create;
GRANT INSERT (name, phone, email, notes) ON pastry.clients TO src_pastry_client_create;
GRANT USAGE ON SEQUENCE pastry.clients_id_seq TO src_pastry_client_create;

GRANT SELECT (id, name, phone, email, notes) ON pastry.clients TO src_pastry_client_update;
GRANT UPDATE (name, phone, email, notes, updated_at) ON pastry.clients TO src_pastry_client_update;

-- cake types
GRANT SELECT (id) ON pastry.cake_types TO src_pastry_cake_type_create;
GRANT INSERT (name, price_per_kg, active, notes) ON pastry.cake_types TO src_pastry_cake_type_create;
GRANT USAGE ON SEQUENCE pastry.cake_types_id_seq TO src_pastry_cake_type_create;

GRANT SELECT (id, name, price_per_kg, active, notes) ON pastry.cake_types TO src_pastry_cake_type_update;
GRANT UPDATE (name, price_per_kg, active, notes) ON pastry.cake_types TO src_pastry_cake_type_update;

-- recipe lines
GRANT SELECT (id, name) ON pastry.cake_types TO src_pastry_recipe_upsert, src_pastry_recipe_delete;
GRANT SELECT (id, name, unit) ON pastry.ingredients TO src_pastry_recipe_upsert, src_pastry_recipe_delete;
GRANT SELECT (cake_type_id, ingredient_id, qty_per_kg) ON pastry.recipe_lines TO src_pastry_recipe_upsert, src_pastry_recipe_delete;
GRANT INSERT (cake_type_id, ingredient_id, qty_per_kg) ON pastry.recipe_lines TO src_pastry_recipe_upsert;
GRANT UPDATE (qty_per_kg) ON pastry.recipe_lines TO src_pastry_recipe_upsert;
GRANT DELETE ON pastry.recipe_lines TO src_pastry_recipe_delete;

-- ingredients
GRANT SELECT (id) ON pastry.ingredients TO src_pastry_ingredient_create;
GRANT INSERT (name, unit, stock_qty, low_threshold) ON pastry.ingredients TO src_pastry_ingredient_create;
GRANT USAGE ON SEQUENCE pastry.ingredients_id_seq TO src_pastry_ingredient_create;

GRANT SELECT (id, name, unit, stock_qty, low_threshold) ON pastry.ingredients TO src_pastry_ingredient_update;
GRANT UPDATE (name, unit, low_threshold) ON pastry.ingredients TO src_pastry_ingredient_update;

-- stock receive / adjust
GRANT SELECT (id, name, unit, stock_qty) ON pastry.ingredients TO src_pastry_stock_receive, src_pastry_stock_adjust;
GRANT UPDATE (stock_qty) ON pastry.ingredients TO src_pastry_stock_receive, src_pastry_stock_adjust;
GRANT INSERT (ingredient_id, qty_delta, reason, order_id, note, decided_by) ON pastry.stock_moves
  TO src_pastry_stock_receive, src_pastry_stock_adjust;
GRANT USAGE ON SEQUENCE pastry.stock_moves_id_seq TO src_pastry_stock_receive, src_pastry_stock_adjust;

-- orders
GRANT SELECT (id, name) ON pastry.clients TO src_pastry_order_create;
GRANT SELECT (id, name, price_per_kg, active) ON pastry.cake_types TO src_pastry_order_create;
GRANT SELECT (id) ON pastry.orders TO src_pastry_order_create;
GRANT INSERT (client_id, cake_type_id, weight_g, status, ordered_at, due_at, due_time, price_rub, prepaid_rub, comment, created_by)
  ON pastry.orders TO src_pastry_order_create;
GRANT USAGE ON SEQUENCE pastry.orders_id_seq TO src_pastry_order_create;

GRANT SELECT (id, client_id, cake_type_id, weight_g, status, ordered_at, due_at, due_time, price_rub, prepaid_rub, comment, stock_deducted)
  ON pastry.orders TO src_pastry_order_update;
GRANT SELECT (id, name) ON pastry.clients TO src_pastry_order_update;
GRANT SELECT (id, name) ON pastry.cake_types TO src_pastry_order_update;
GRANT UPDATE (status, ordered_at, due_at, due_time, price_rub, prepaid_rub, comment, updated_at)
  ON pastry.orders TO src_pastry_order_update;

-- start baking: списание по рецепту × вес
GRANT SELECT (id, client_id, cake_type_id, weight_g, status, stock_deducted) ON pastry.orders TO src_pastry_order_start_baking;
GRANT SELECT (id, name) ON pastry.cake_types TO src_pastry_order_start_baking;
GRANT SELECT (id, name) ON pastry.clients TO src_pastry_order_start_baking;
GRANT SELECT (cake_type_id, ingredient_id, qty_per_kg) ON pastry.recipe_lines TO src_pastry_order_start_baking;
GRANT SELECT (id, name, unit, stock_qty) ON pastry.ingredients TO src_pastry_order_start_baking;
GRANT UPDATE (stock_qty) ON pastry.ingredients TO src_pastry_order_start_baking;
GRANT UPDATE (status, stock_deducted, updated_at) ON pastry.orders TO src_pastry_order_start_baking;
GRANT INSERT (ingredient_id, qty_delta, reason, order_id, note, decided_by) ON pastry.stock_moves TO src_pastry_order_start_baking;
GRANT USAGE ON SEQUENCE pastry.stock_moves_id_seq TO src_pastry_order_start_baking;

-- Демо-каталог (один раз; повторный прогон не дублирует по UNIQUE name)
INSERT INTO pastry.ingredients (name, unit, stock_qty, low_threshold) VALUES
  ('Мука пшеничная', 'g', 10000, 2000),
  ('Сахар', 'g', 5000, 1000),
  ('Масло сливочное', 'g', 3000, 500),
  ('Яйца', 'pcs', 60, 12),
  ('Молоко', 'ml', 4000, 1000),
  ('Какао', 'g', 800, 200),
  ('Сливки 33%', 'ml', 2000, 500),
  ('Ягоды микс', 'g', 1500, 300)
ON CONFLICT (name) DO NOTHING;

INSERT INTO pastry.cake_types (name, price_per_kg, active, notes) VALUES
  ('Медовик', 2200, true, 'Классический медовый торт'),
  ('Наполеон', 2400, true, ''),
  ('Шоколадный', 2600, true, 'С ганашем'),
  ('Ягодный мусс', 2800, true, 'Лёгкий муссовый')
ON CONFLICT (name) DO NOTHING;

INSERT INTO pastry.recipe_lines (cake_type_id, ingredient_id, qty_per_kg)
SELECT c.id, i.id, v.qty
FROM (VALUES
  ('Медовик', 'Мука пшеничная', 280),
  ('Медовик', 'Сахар', 220),
  ('Медовик', 'Масло сливочное', 180),
  ('Медовик', 'Яйца', 4),
  ('Медовик', 'Сливки 33%', 200),
  ('Наполеон', 'Мука пшеничная', 300),
  ('Наполеон', 'Масло сливочное', 250),
  ('Наполеон', 'Яйца', 3),
  ('Наполеон', 'Молоко', 400),
  ('Наполеон', 'Сахар', 180),
  ('Шоколадный', 'Мука пшеничная', 220),
  ('Шоколадный', 'Сахар', 240),
  ('Шоколадный', 'Масло сливочное', 160),
  ('Шоколадный', 'Яйца', 5),
  ('Шоколадный', 'Какао', 80),
  ('Шоколадный', 'Сливки 33%', 250),
  ('Ягодный мусс', 'Сахар', 180),
  ('Ягодный мусс', 'Сливки 33%', 350),
  ('Ягодный мусс', 'Ягоды микс', 280),
  ('Ягодный мусс', 'Яйца', 2)
) AS v(cake, ing, qty)
JOIN pastry.cake_types c ON c.name = v.cake
JOIN pastry.ingredients i ON i.name = v.ing
ON CONFLICT (cake_type_id, ingredient_id) DO NOTHING;

INSERT INTO pastry.clients (name, phone, email, notes)
SELECT v.name, v.phone, v.email, v.notes
FROM (VALUES
  ('Мария Иванова', '+7 900 111-22-33', 'maria@example.com', 'Любит медовик, без орехов'),
  ('Алексей Петров', '+7 900 444-55-66', '', 'Корпоративные заказы'),
  ('Ольга Сидорова', '+7 900 777-88-99', 'olga@example.com', '')
) AS v(name, phone, email, notes)
WHERE NOT EXISTS (SELECT 1 FROM pastry.clients LIMIT 1);

INSERT INTO pastry.orders (client_id, cake_type_id, weight_g, status, ordered_at, due_at, due_time, price_rub, prepaid_rub, comment, created_by)
SELECT cl.id, ct.id, v.weight_g, v.status, current_date + v.ord, current_date + v.due, v.due_time, v.price, v.prepaid, v.comment, 'демо'
FROM (VALUES
  ('Мария Иванова', 'Медовик', 1500, 'confirmed', -2, 1, '18:00', 3300, 1000, 'Надпись: С днём рождения!'),
  ('Алексей Петров', 'Шоколадный', 2000, 'new', 0, 3, '12:00', 5200, 2000, ''),
  ('Ольга Сидорова', 'Ягодный мусс', 1000, 'ready', -5, 0, '15:30', 2800, 2800, 'Без желатина — уже учтено')
) AS v(client, cake, weight_g, status, ord, due, due_time, price, prepaid, comment)
JOIN pastry.clients cl ON cl.name = v.client
JOIN pastry.cake_types ct ON ct.name = v.cake
WHERE NOT EXISTS (SELECT 1 FROM pastry.orders LIMIT 1);
SQL
