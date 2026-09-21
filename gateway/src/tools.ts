import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Manifest } from '@sandbox/manifest';
import { config, registry } from './config.ts';
import { service } from './db.ts';
import { HttpError, forbidden, unauthorized } from './errors.ts';
import { ownersOf } from './directory.ts';

const ISSUER = 'sandbox-gateway';
const AUDIENCE = 'sandbox-tools';

export interface ToolRow {
  name: string;
  owner: string;
  manifest: Manifest;
  secret_hash: string;
  updated_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  registered_at: Date;
  confirmed_at: Date;
  last_human_at: Date | null;
  idle_notified_at: Date | null;
  idle_revived_at: Date | null;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export async function loadTool(name: string): Promise<ToolRow | undefined> {
  const { rows } = await service.query<ToolRow>('SELECT * FROM gateway.tools WHERE name = $1', [name]);
  return rows[0];
}

function assertAlive(tool: ToolRow): void {
  if (tool.revoked_at) throw forbidden(`тул ${tool.name} отозван`);
  if (tool.expires_at.getTime() <= Date.now()) {
    throw forbidden(`срок жизни тула ${tool.name} истёк ${tool.expires_at.toISOString()}; владелец ${tool.owner} не продлил его`);
  }
}

/**
 * Допуск тула в контур по уже провалидированному манифесту.
 * Каждый деплой ротирует секрет и инвалидирует ранее выданные токены.
 * Прод: срок жизни отсчитывается от первой регистрации, передеплой его не продлевает,
 * а истёкший или отозванный тул обратно не пускается — только продлением.
 * Превью (freshLifetime): каждый деплой начинает короткий срок заново.
 */
export async function registerTool(
  m: Manifest,
  instance: string,
  ttlDays: number,
  freshLifetime: boolean,
): Promise<{ secret: string; expiresAt: Date }> {
  const existing = await loadTool(instance);
  if (existing && !freshLifetime) assertAlive(existing);

  const secret = randomBytes(32).toString('base64url');
  const { rows } = await service.query<{ expires_at: Date }>(
    `INSERT INTO gateway.tools (name, owner, manifest, secret_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
     ON CONFLICT (name) DO UPDATE
       SET owner = EXCLUDED.owner, manifest = EXCLUDED.manifest,
           secret_hash = EXCLUDED.secret_hash, updated_at = now(),
           expires_at = CASE WHEN $6 THEN EXCLUDED.expires_at ELSE gateway.tools.expires_at END,
           confirmed_at = CASE WHEN $6 THEN now() ELSE gateway.tools.confirmed_at END,
           revoked_at = CASE WHEN $6 THEN NULL ELSE gateway.tools.revoked_at END
     RETURNING expires_at`,
    [instance, m.owner, m, hash(secret), ttlDays, freshLifetime],
  );
  return { secret, expiresAt: rows[0]!.expires_at };
}

export async function issueToken(name: string, secret: string): Promise<{ token: string; expiresIn: number }> {
  const tool = await loadTool(name);
  const given = Buffer.from(hash(secret));
  if (!tool || !timingSafeEqual(given, Buffer.from(tool.secret_hash))) {
    throw unauthorized('неверное имя тула или секрет');
  }
  assertAlive(tool);

  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + registry.policy.token_ttl_seconds, Math.floor(tool.expires_at.getTime() / 1000));
  const token = await new SignJWT({ ver: tool.updated_at.getTime() })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(tool.name)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(config.jwtSecret);
  return { token, expiresIn: exp - now };
}

/**
 * Проверка токена на каждом запросе. Скоуп берётся из актуального манифеста в БД,
 * а не из токена: отзыв, истечение TTL и передеплой действуют немедленно.
 */
export async function authenticate(bearer: string | undefined): Promise<ToolRow> {
  if (!bearer?.startsWith('Bearer ')) throw unauthorized('нужен заголовок Authorization: Bearer <токен тула>');
  let sub: string;
  let ver: unknown;
  try {
    const { payload } = await jwtVerify(bearer.slice(7), config.jwtSecret, { issuer: ISSUER, audience: AUDIENCE });
    sub = payload.sub!;
    ver = payload.ver;
  } catch (e) {
    throw unauthorized(`токен недействителен: ${(e as Error).message}`);
  }
  const tool = await loadTool(sub);
  if (!tool) throw unauthorized(`тул ${sub} не зарегистрирован`);
  assertAlive(tool);
  if (ver !== tool.updated_at.getTime()) {
    throw new HttpError(401, 'token_superseded', 'тул передеплоен, токен устарел — получите новый');
  }
  return tool;
}

export async function listTools() {
  const { rows } = await service.query<Omit<ToolRow, 'secret_hash' | 'manifest'> & { sources: string[]; writes: string[] }>(
    `SELECT name, owner, registered_at, updated_at, expires_at, revoked_at, confirmed_at, last_human_at, idle_notified_at,
            CASE WHEN name LIKE '%--%' THEN NULL ELSE confirmed_at + make_interval(days => $1) END AS auto_extend_until,
            ARRAY(SELECT jsonb_array_elements_text(manifest->'sources')) AS sources,
            ARRAY(SELECT jsonb_array_elements_text(manifest->'writes'))  AS writes
       FROM gateway.tools ORDER BY name`,
    [registry.policy.max_ttl_days],
  );
  return rows;
}

/**
 * Явное продление владельцем — решение человека. Не дольше лимита реестра от текущего момента.
 * С этого момента заново отсчитывается предел автопродления (confirmed_at + max_ttl_days).
 */
export async function extendTool(name: string, days: number): Promise<Date> {
  const tool = await loadTool(name);
  if (!tool) throw new HttpError(404, 'not_found', `тул ${name} не зарегистрирован`);
  if (tool.revoked_at) throw forbidden(`тул ${name} отозван, продлить нельзя`);
  const capped = Math.min(days, registry.policy.max_ttl_days);
  const { rows } = await service.query<{ expires_at: Date }>(
    `UPDATE gateway.tools
        SET expires_at = now() + make_interval(days => $2), confirmed_at = now(), idle_notified_at = NULL
      WHERE name = $1 RETURNING expires_at`,
    [name, capped],
  );
  return rows[0]!.expires_at;
}

const isPreview = (name: string) => name.includes('--');

/**
 * Использование человеком продлевает прод-тул на его ttl_days, но не дальше предела
 * confirmed_at + max_ttl_days: после него нужно явное продление, молчание — отказ.
 * Вызовы только от агента срок не двигают. Пишем не чаще раза в минуту на тул.
 * Возвращает true, если вызов снял уведомление о простое.
 */
export async function touchByHuman(tool: ToolRow): Promise<boolean> {
  if (isPreview(tool.name)) return false;
  const { rows } = await service.query<{ was_idle: boolean }>(
    `UPDATE gateway.tools t
        SET last_human_at = now(),
            idle_revived_at = CASE WHEN t.idle_notified_at IS NOT NULL THEN now() ELSE t.idle_revived_at END,
            idle_notified_at = NULL,
            expires_at = GREATEST(t.expires_at, LEAST(now() + make_interval(days => $2), t.confirmed_at + make_interval(days => $3)))
       FROM (SELECT idle_notified_at IS NOT NULL AS was_idle FROM gateway.tools WHERE name = $1) old
      WHERE t.name = $1 AND t.revoked_at IS NULL
        AND (t.last_human_at IS NULL OR t.last_human_at < now() - interval '1 minute' OR t.idle_notified_at IS NOT NULL)
      RETURNING old.was_idle`,
    [tool.name, tool.manifest.ttl_days, registry.policy.max_ttl_days],
  );
  return rows[0]?.was_idle ?? false;
}

/**
 * Простой: нет вызовов человека idle_days дней → уведомление владельцу и укорочение срока
 * до idle_grace_days. Вызов человеком или продление снимают уведомление; иначе уборщик удалит тул.
 */
export async function markIdle() {
  const { idle_days, idle_grace_days } = registry.policy;
  const { rows } = await service.query<{ name: string; owner: string; expires_at: Date; last_human_at: Date | null }>(
    `UPDATE gateway.tools
        SET idle_notified_at = now(), expires_at = LEAST(expires_at, now() + make_interval(days => $2))
      WHERE revoked_at IS NULL AND idle_notified_at IS NULL AND expires_at > now()
        AND COALESCE(last_human_at, confirmed_at) < now() - make_interval(days => $1)
      RETURNING name, owner, expires_at, last_human_at`,
    [idle_days, idle_grace_days],
  );
  return rows;
}

/**
 * Тулы без того, кто за них решает (владелец ушёл без работающего руководителя, в группе никого) — сразу в простой:
 * срок сокращается до idle_grace_days, администраторы песочницы получают уведомление. Превью не трогаем — живут своё.
 */
export async function markOrphans() {
  const { rows: live } = await service.query<{ name: string; owner: string }>(
    `SELECT name, owner FROM gateway.tools
      WHERE revoked_at IS NULL AND idle_notified_at IS NULL AND expires_at > now() AND name NOT LIKE '%--%'`,
  );
  const orphans = live.filter((t) => ownersOf(t.owner).kind === 'orphan').map((t) => t.name);
  if (!orphans.length) return [];
  const { rows } = await service.query<{ name: string; owner: string; expires_at: Date; last_human_at: Date | null }>(
    `UPDATE gateway.tools
        SET idle_notified_at = now(), expires_at = LEAST(expires_at, now() + make_interval(days => $2))
      WHERE name = ANY($1) AND idle_notified_at IS NULL
      RETURNING name, owner, expires_at, last_human_at`,
    [orphans, registry.policy.idle_grace_days],
  );
  return rows;
}

/** Что тул и его владелец видят о сроке жизни. */
export function lifecycleOf(tool: ToolRow) {
  const cap = new Date(tool.confirmed_at.getTime() + registry.policy.max_ttl_days * 86_400_000);
  return {
    tool: tool.name,
    owner: tool.owner,
    // Кто решает за владельца по справочнику: ушёл — руководитель, группа — её участники.
    owners: ownersOf(tool.owner).logins,
    owner_note: ownersOf(tool.owner).note,
    expires_at: tool.expires_at,
    auto_extend_until: isPreview(tool.name) ? null : cap,
    auto_extend_days: isPreview(tool.name) ? 0 : tool.manifest.ttl_days,
    last_human_at: tool.last_human_at,
    idle_notified_at: tool.idle_notified_at,
    // Простой прерван заходом человека меньше суток назад: удаление отменено, но владельцу стоит решить.
    idle_revived_at: tool.idle_revived_at && Date.now() - tool.idle_revived_at.getTime() < 86_400_000 ? tool.idle_revived_at : null,
    idle_days: registry.policy.idle_days,
    max_ttl_days: registry.policy.max_ttl_days,
  };
}

/** Досрочное завершение. Токены перестают работать сразу, уборщик удаляет ресурсы. */
export async function revokeTool(name: string): Promise<void> {
  const res = await service.query('UPDATE gateway.tools SET revoked_at = now() WHERE name = $1 AND revoked_at IS NULL', [name]);
  if (res.rowCount !== 1) throw new HttpError(404, 'not_found', `активный тул ${name} не найден`);
}

/** Живые превью (<тул>--<ветка>): не отозваны и не истекли. */
export async function activePreviews(): Promise<{ name: string; expires_at: Date }[]> {
  const { rows } = await service.query<{ name: string; expires_at: Date }>(
    `SELECT name, expires_at FROM gateway.tools
      WHERE name LIKE '%--%' AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at`,
  );
  return rows;
}
