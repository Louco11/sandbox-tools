/**
 * Личные ключи MCP (шаг Б2). Ключ принадлежит человеку, а не тулу: одним ключом он подключает любые доступные
 * ему тулы, а права проверяются на каждом вызове — поэтому при смене групп ключ не перевыпускают.
 *
 * Формат: sbx_<префикс>_<секрет>. В базе только префикс (по нему ищем, он же попадает в логи и аудит) и sha256
 * секрета. Сам ключ показывается один раз при выпуске и больше нигде не хранится и не логируется.
 *
 * Отзыв действует сразу: проверка идёт в базу на каждом вызове, кэша ключей нет.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { service as pool } from './db.ts';

const DEFAULT_DAYS = Number(process.env.MCP_KEY_DAYS ?? 90);
/** Сколько ещё живёт прежний ключ после перевыпуска человеком: чтобы агент не умер посреди работы. */
export const GRACE_HOURS = Number(process.env.MCP_KEY_GRACE_HOURS ?? 24);

export interface KeyRow {
  id: number; owner: string; name: string; prefix: string;
  created_at: Date; created_by: string; expires_at: Date;
  last_used_at: Date | null; last_agent: string | null; last_ip: string | null;
  revoked_at: Date | null; revoked_by: string | null; revoke_reason: string | null;
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Запись в общий аудит платформы: выпуск, отзыв, ротация и вызовы с негодным ключом. */
export async function auditKey(e: { actor: string; operation: string; allowed: boolean; reason?: string; tool?: string }): Promise<void> {
  await pool.query(
    `INSERT INTO audit.calls (request_id, actor, tool, operation, agent_in_chain, allowed, reason)
     VALUES (gen_random_uuid()::text, $1, $2, $3, false, $4, $5)`,
    [e.actor, e.tool ?? 'identity', e.operation, e.allowed, e.reason ?? null],
  ).catch((err: Error) => console.error(JSON.stringify({ type: 'audit_failed', error: err.message })));
}

export async function listKeys(owner: string): Promise<KeyRow[]> {
  const { rows } = await pool.query<KeyRow>(
    `SELECT * FROM identity.keys WHERE owner = $1 AND (revoked_at IS NULL OR revoked_at > now() - interval '7 days')
      ORDER BY revoked_at NULLS FIRST, created_at DESC`,
    [owner],
  );
  return rows;
}

/** Выпуск. Секрет возвращается один раз — ни в базе, ни в логах его нет. */
export async function issueKey(p: { owner: string; name: string; by: string; days?: number }): Promise<{ key: string; row: KeyRow }> {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(24).toString('base64url');
  const { rows } = await pool.query<KeyRow>(
    `INSERT INTO identity.keys (owner, name, prefix, secret_hash, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING *`,
    [p.owner, p.name.slice(0, 80), prefix, sha256(secret), p.by, p.days ?? DEFAULT_DAYS],
  );
  await auditKey({ actor: p.by, operation: 'key.issue', allowed: true, reason: `ключ ${prefix} для ${p.owner} на ${p.days ?? DEFAULT_DAYS} дн.` });
  return { key: `sbx_${prefix}_${secret}`, row: rows[0]! };
}

export async function revokeKey(p: { prefix: string; by: string; owner?: string; reason: string; graceHours?: number }): Promise<boolean> {
  const at = p.graceHours ? `now() + make_interval(hours => ${Number(p.graceHours)})` : 'now()';
  const { rowCount } = await pool.query(
    `UPDATE identity.keys SET revoked_at = ${at}, revoked_by = $2, revoke_reason = $3
      WHERE prefix = $1 AND revoked_at IS NULL ${p.owner ? 'AND owner = $4' : ''}`,
    p.owner ? [p.prefix, p.by, p.reason, p.owner] : [p.prefix, p.by, p.reason],
  );
  if (rowCount) await auditKey({ actor: p.by, operation: 'key.revoke', allowed: true, reason: `ключ ${p.prefix}: ${p.reason}` });
  return Boolean(rowCount);
}

/** Отзыв всех ключей человека — при утечке или уходе из компании. Делает администратор. */
export async function revokeAll(p: { owner: string; by: string; reason: string }): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE identity.keys SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE owner = $1 AND revoked_at IS NULL`,
    [p.owner, p.by, p.reason],
  );
  if (rowCount) await auditKey({ actor: p.by, operation: 'key.revoke_all', allowed: true, reason: `${rowCount} ключей ${p.owner}: ${p.reason}` });
  return rowCount ?? 0;
}

export interface KeyCheck { owner: string; prefix: string }

/**
 * Проверка ключа на вызове: находим по префиксу, сверяем хэш, смотрим срок и отзыв.
 * Здесь же отмечаем, когда и чем ключом пользовались — чтобы человек видел это в кабинете.
 */
export async function checkKey(raw: string, meta: { agent?: string; ip?: string }): Promise<KeyCheck | null> {
  const m = /^sbx_([0-9a-f]{8})_([A-Za-z0-9_-]{16,})$/.exec(raw);
  if (!m) return null;
  const [, prefix, secret] = m;
  const { rows } = await pool.query<{ owner: string; secret_hash: string; expires_at: Date; revoked_at: Date | null }>(
    'SELECT owner, secret_hash, expires_at, revoked_at FROM identity.keys WHERE prefix = $1',
    [prefix],
  );
  const row = rows[0];
  if (!row || !sameHash(row.secret_hash, sha256(secret!))) return null;
  const now = Date.now();
  if (row.revoked_at && row.revoked_at.getTime() <= now) {
    await auditKey({ actor: row.owner, operation: 'key.denied', allowed: false, reason: `ключ ${prefix} отозван` });
    return null;
  }
  if (row.expires_at.getTime() <= now) {
    await auditKey({ actor: row.owner, operation: 'key.denied', allowed: false, reason: `ключ ${prefix} истёк` });
    return null;
  }
  await pool.query(
    'UPDATE identity.keys SET last_used_at = now(), last_agent = COALESCE($2, last_agent), last_ip = COALESCE($3, last_ip) WHERE prefix = $1',
    [prefix, meta.agent?.slice(0, 120) ?? null, meta.ip?.slice(0, 60) ?? null],
  );
  return { owner: row.owner, prefix: prefix! };
}
