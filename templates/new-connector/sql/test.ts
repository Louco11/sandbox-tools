/**
 * Проверка коннектора «__TITLE__» на временной базе: Postgres в Docker со схемой и данными из test/schema.sql.
 * Настоящую базу проверка не трогает. Сценарий: какие таблицы и как должны измениться (changes) — остальные не должны.
 */
import { join } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';
import { changes, pgTestSystem } from '../../packages/connector/src/testkit-pg.ts';

export default defineConnectorTest({
  hosts: [],
  async start() {
    const pg = await pgTestSystem({ initDir: join(import.meta.dirname, 'test'), schemas: ['app'] });
    return {
      ...pg,
      env: {
        DB_HOST: pg.env.PG_HOST!, DB_PORT: pg.env.PG_PORT!, DB_NAME: pg.env.PG_DATABASE!,
        DB_READ_USER: 'connector_read', DB_READ_PASSWORD: 'test',
        DB_WRITE_USER: 'connector_write', DB_WRITE_PASSWORD: 'test',
      },
    };
  },
  variants: [{
    source: '__SOURCE__',
    scenarios: [
      { write: '__PREFIX__.item:set_status', params: { item_id: 1, status: 'archived' }, expect: changes({ 'app.items': 0 }) },
    ],
  }],
});
