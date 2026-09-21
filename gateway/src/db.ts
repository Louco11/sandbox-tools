import pg from 'pg';
import { config } from './config.ts';

function pool(user: string, password: string): pg.Pool {
  return new pg.Pool({
    host: config.pg.host,
    port: config.pg.port,
    database: config.pg.database,
    user,
    password,
    max: 5,
    options: '-c statement_timeout=5000',
  });
}

// Своё состояние и аудит. К данным источников у этой роли доступа нет.
export const service = pool('gateway_service', config.pg.servicePassword);
