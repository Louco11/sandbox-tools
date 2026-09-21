/**
 * Коннектор «Автопарк» — машины компании и их цена. Система своя: отдельная база Postgres (`cars-db`),
 * песочница в неё не ходит и ходить не может — только в этот сервис, а он стоит за гейтвеем.
 *
 * Только чтение: цену и пробег правят в учётной системе автопарка, а не через песочницу. Появится право
 * записи — здесь добавится обработчик, а в реестре запись с `confirm` для необратимого.
 * Адрес и учётка — из окружения; в коде их нет. Чтение — `sqlSelect`: таблица и колонки отсюда,
 * значения из запроса уходят параметрами.
 */
import pg from 'pg';
import { sqlSelect, startConnector, type Row } from '../../packages/connector/src/index.ts';

const read = new pg.Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT ?? 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_READ_USER,
  password: process.env.DB_READ_PASSWORD,
  max: 5,
  options: '-c statement_timeout=5000',
});

// Набор данных → таблица и колонки. Колонки — ровно поля из реестра: лишнего коннектор не отдаёт.
const DATASETS = {
  cars: {
    table: 'fleet.cars',
    columns: ['id', 'brand', 'model', 'year', 'price_rub', 'mileage_km', 'city', 'status', 'updated_at'],
  },
};

startConnector({
  name: 'cars',
  token: process.env.CONNECTOR_TOKEN ?? '',
  datasets: Object.fromEntries(Object.entries(DATASETS).map(([ds, d]) => [ds, async (q) => {
    const { text, values } = sqlSelect(d.table, d.columns, q);
    return (await read.query<Row>(text, values)).rows;
  }])),
  writes: {},
});
