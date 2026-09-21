/**
 * Подключение сервиса личности к своей схеме. Роль `identity_service` видит только `identity.*` и пишет в аудит:
 * данные источников ей недоступны — это проверяется грантами, а не доверием (`infra/postgres/init/08-identity.sh`).
 */
import pg from 'pg';

export const service = new pg.Pool({
  host: process.env.PG_HOST ?? 'postgres',
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? 'sources',
  user: 'identity_service',
  password: process.env.PG_IDENTITY_PASSWORD ?? '',
  max: 4,
});
