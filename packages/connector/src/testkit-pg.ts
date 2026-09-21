/**
 * Тестовая система «временный Postgres» для проверки коннекторов к базам: контейнер из init-скриптов (схема и
 * тестовые данные), тестовые пароли, порт на 127.0.0.1. Снимок — число строк и хэш содержимого каждой таблицы.
 * Только для test.ts — боевых баз здесь нет.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import type { ConnectorTestSystem } from './testkit.ts';

export type PgSnap = Record<string, { n: number; h: string }>;

export async function pgTestSystem(opts: {
  /** Каталог init-скриптов (*.sql, *.sh) — схема и тестовые данные. */
  initDir: string;
  /** Схемы, таблицы которых входят в снимок. */
  schemas: string[];
  /** Переменные окружения контейнера Postgres (например, пароли ролей для init-скриптов). */
  env?: Record<string, string>;
  database?: string;
}): Promise<ConnectorTestSystem & { port: string }> {
  const db = opts.database ?? 'test';
  const name = `sandbox-connector-test-${process.pid}-${Date.now()}`;
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::5432',
    '-e', `POSTGRES_DB=${db}`, '-e', 'POSTGRES_USER=test_admin', '-e', 'POSTGRES_PASSWORD=test',
    ...Object.entries(opts.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${opts.initDir}:/docker-entrypoint-initdb.d:ro`, 'postgres:17-alpine',
  ], { stdio: 'ignore' });
  const psql = (sql: string) => spawnSync('docker', ['exec', '-i', name, 'psql', '-U', 'test_admin', '-d', db, '-qAt', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8' });
  const stop = async () => void spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  try {
    // Готов, когда init-скрипты прошли и сервер перезапустился в рабочем режиме (TCP принимает подключения).
    for (let i = 0; ; i++) {
      const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'test_admin', '-d', db]).status === 0;
      if (ready && psql('SELECT 1').status === 0) break;
      if (i > 90) throw new Error(`тестовый Postgres не поднялся за 90 с: ${spawnSync('docker', ['logs', '--tail', '20', name], { encoding: 'utf8' }).stderr}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    const port = execFileSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).trim().split('\n')[0]!.split(':').at(-1)!;
    const tables = psql(`SELECT table_schema || '.' || table_name FROM information_schema.tables
       WHERE table_schema IN ('${opts.schemas.join("','")}') AND table_type = 'BASE TABLE' ORDER BY 1`).stdout.trim().split('\n').filter(Boolean);
    if (!tables.length) throw new Error(`в схемах ${opts.schemas.join(', ')} нет таблиц — init-скрипты отработали?`);
    const snapSql = `SELECT json_object_agg(t, json_build_object('n', n, 'h', h)) FROM (${tables
      .map((t) => `SELECT '${t}' t, count(*) n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) h FROM ${t} x`)
      .join(' UNION ALL ')}) s`;
    return {
      port,
      env: { PG_HOST: '127.0.0.1', PG_PORT: port, PG_DATABASE: db },
      snapshot: async () => JSON.parse(psql(snapSql).stdout) as PgSnap,
      stop,
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/**
 * Ожидание сценария: таблица → на сколько изменилось число строк (0 — те же строки, другое содержимое).
 * Любая другая изменившаяся таблица — провал: apply делает только обещанное.
 */
export const changes = (spec: Record<string, number>) => (b: PgSnap, a: PgSnap): string | undefined => {
  const problems: string[] = [];
  for (const t of Object.keys(a)) {
    const want = spec[t];
    const same = a[t]!.h === b[t]!.h;
    if (want === undefined) {
      if (!same) problems.push(`изменилась ${t}, хотя не должна`);
    } else if (a[t]!.n - b[t]!.n !== want) problems.push(`${t}: строк ${b[t]!.n} → ${a[t]!.n}, ожидалось ${want >= 0 ? '+' : ''}${want}`);
    else if (want === 0 && same) problems.push(`${t} не изменилась`);
  }
  return problems.join('; ') || undefined;
};
