/**
 * Проверка коннектора «Автопарк» на временной базе: Postgres в Docker со схемой и данными из test/schema.sql.
 * Настоящую базу проверка не трогает. Прав записи у источника нет, поэтому сценариев записи тоже нет —
 * проверяется состав наборов, поля и то, что коннектор без токена гейтвея никому не отвечает.
 */
import { join } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';
import { pgTestSystem } from '../../packages/connector/src/testkit-pg.ts';

export default defineConnectorTest({
  hosts: [],
  async start() {
    const pg = await pgTestSystem({ initDir: join(import.meta.dirname, 'test'), schemas: ['fleet'] });
    return {
      ...pg,
      env: {
        DB_HOST: pg.env.PG_HOST!,
        DB_PORT: pg.env.PG_PORT!,
        DB_NAME: pg.env.PG_DATABASE!,
        DB_READ_USER: 'connector_read',
        DB_READ_PASSWORD: 'test',
      },
    };
  },
  variants: [{ source: 'cars-readonly', scenarios: [] }],
});
