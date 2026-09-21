/**
 * Общее для обработчиков записи источников postgres: типы, проверки дат, склонения, транзакции, ошибки.
 * Код перенесён из gateway/src/writes.ts без изменений логики (шаг А1.2): в гейтвее кода источников больше нет.
 */
import type pg from 'pg';
import { ConnectorError } from '../../../packages/connector/src/index.ts';

export type Params = Record<string, string | number>;
export type SqlClient = { query: pg.Pool['query'] };

/** Обработчик записи источника postgres. db — пул роли этого права записи (минимальные гранты). */
export interface PgWriteHandler {
  /** Проверяет, что действие применимо сейчас, и формулирует его для человека. */
  describe(db: pg.Pool, p: Params): Promise<string>;
  /** Выполняет действие. decidedBy — человек, подтвердивший запись; agent — агент, который её подготовил. */
  apply(db: pg.Pool, p: Params, by: { decidedBy: string; agent: string | null }): Promise<Record<string, unknown> | void>;
}

// Ошибки для человека: гейтвей покажет их как есть.
export const badRequest = (message: string) => new ConnectorError(400, message);
export const notFound = (message: string) => new ConnectorError(404, message);
export const conflictError = (message: string) => new ConnectorError(409, message);

export function checkDate(v: string | number | undefined): void {
  if (v === undefined) return;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw badRequest(`due_at: ожидается дата YYYY-MM-DD, получено «${s}»`);
}

export function checkTime(v: string | number | undefined): void {
  if (v === undefined || v === '') return;
  const s = String(v);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw badRequest(`due_time: ожидается HH:MM, получено «${s}»`);
}

export function clip(s: string, n = 120): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const m10 = n % 10;
  const m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
}

export async function inTransaction<T>(db: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
