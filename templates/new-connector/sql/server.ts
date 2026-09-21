/**
 * Коннектор «__TITLE__» к базе данных (Postgres; для другой СУБД — её драйвер и плейсхолдеры).
 * Адрес и учётки — только из окружения. Учёток две, обе с минимальными грантами: чтение (DB_READ_*) и запись
 * (DB_WRITE_*: ровно одобренные записи). Чтение — sqlSelect: таблица и колонки отсюда, значения — параметрами.
 *
 * TODO агенту: заменить демо-таблицу app.items и запись __PREFIX__.item:set_status на свои; то же — в
 * registry.draft.yaml, test/schema.sql и test.ts. Проверка: make validate-connector NAME=__NAME__
 */
import pg from 'pg';
import { ConnectorError, sqlSelect, startConnector, type Row } from '../../packages/connector/src/index.ts';

const pool = (user: string, password: string) => new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env[user],
  password: process.env[password],
  max: 5,
  options: '-c statement_timeout=5000',
});
const read = pool('DB_READ_USER', 'DB_READ_PASSWORD');
const write = pool('DB_WRITE_USER', 'DB_WRITE_PASSWORD');

// Набор данных → таблица и колонки. Колонки — ровно поля из реестра.
const DATASETS = {
  items: { table: 'app.items', columns: ['id', 'name', 'status'] },
};

startConnector({
  name: '__NAME__',
  token: process.env.CONNECTOR_TOKEN ?? '',
  datasets: Object.fromEntries(Object.entries(DATASETS).map(([ds, d]) => [ds, async (q) => {
    const { text, values } = sqlSelect(d.table, d.columns, q);
    return (await read.query<Row>(text, values)).rows;
  }])),
  writes: {
    '__PREFIX__.item:set_status': {
      describe: async (p) => {
        const { rows } = await read.query<{ name: string; status: string }>('SELECT name, status FROM app.items WHERE id = $1', [p.item_id]);
        if (!rows[0]) throw new ConnectorError(404, `позиции #${p.item_id} нет`);
        if (rows[0].status === p.status) throw new ConnectorError(409, `у «${rows[0].name}» уже статус ${p.status}`);
        return `Позиция «${rows[0].name}»: статус ${rows[0].status} → ${p.status}`;
      },
      apply: async (p) => {
        const res = await write.query('UPDATE app.items SET status = $2 WHERE id = $1', [p.item_id, p.status]);
        if (res.rowCount !== 1) throw new ConnectorError(404, `позиции #${p.item_id} нет`);
        return { item_id: p.item_id, status: p.status };
      },
    },
  },
});
