/**
 * Коннектор источников postgres стенда: tasks, knowledge, boards, pastry. Одна кодовая база, экземпляр — на источник:
 *   SOURCE=tasks node connectors/postgres/src/server.ts
 * У экземпляра — только роли своего источника (чтение + по роли на право записи, минимальные гранты), пароли — в его
 * окружении. Гейтвей ходит сюда по токену (CONNECTOR_TOKEN) и о таблицах и ролях ничего не знает.
 * Чтение — sqlSelect: поля и таблица из описания источника, значения — параметрами.
 */
import pg from 'pg';
import { startConnector, sqlSelect, type Row, type WriteHandler } from '../../../packages/connector/src/index.ts';
import type { Params, PgWriteHandler } from './util.ts';
import * as boards from './sources/boards.ts';
import * as knowledge from './sources/knowledge.ts';
import * as pastry from './sources/pastry.ts';
import * as tasks from './sources/tasks.ts';

interface PgSource {
  read: { role: string; password_env: string };
  datasets: Record<string, { table: string; columns: string[] }>;
  roles: Record<string, { role: string; password_env: string }>;
  writes: Record<string, PgWriteHandler>;
}

const SOURCES: Record<string, PgSource> = { tasks, knowledge, boards, pastry };
const name = process.env.SOURCE ?? '';
const source = SOURCES[name];
if (!source) throw new Error(`SOURCE=${name}: ожидается ${Object.keys(SOURCES).join(' | ')}`);

const missing = Object.keys(source.writes).filter((w) => !source.roles[w]);
if (missing.length) throw new Error(`у записей нет роли БД: ${missing.join(', ')}`);

const pools = new Map<string, pg.Pool>();
function pool(r: { role: string; password_env: string }): pg.Pool {
  let p = pools.get(r.role);
  if (!p) {
    const password = process.env[r.password_env];
    if (!password) throw new Error(`нет пароля ${r.password_env} для роли ${r.role}`);
    p = new pg.Pool({
      host: process.env.PG_HOST ?? 'postgres',
      port: Number(process.env.PG_PORT ?? 5432),
      database: process.env.PG_DATABASE ?? 'sources',
      user: r.role,
      password,
      max: 5,
      options: '-c statement_timeout=5000',
    });
    pools.set(r.role, p);
  }
  return p;
}
// Все пароли — при старте: без них коннектор не поднимается, а не падает на первой записи.
[source.read, ...Object.values(source.roles)].forEach(pool);

startConnector({
  name,
  token: process.env.CONNECTOR_TOKEN ?? '',
  datasets: Object.fromEntries(
    Object.entries(source.datasets).map(([ds, { table, columns }]) => [
      ds,
      async (q) => {
        const { text, values } = sqlSelect(table, columns, q);
        return (await pool(source.read).query<Row>(text, values)).rows;
      },
    ]),
  ),
  writes: Object.fromEntries(
    Object.entries(source.writes).map(([id, h]): [string, WriteHandler] => {
      const db = pool(source.roles[id]!);
      return [id, {
        describe: (p: Params) => h.describe(db, p),
        apply: async (p: Params, by) => (await h.apply(db, p, { decidedBy: by.decided_by, agent: by.agent })) ?? {},
      }];
    }),
  ),
});
