/**
 * Доступ агента к Gitea от имени его человека (шаг Б6).
 *
 * Раньше все агенты пушили под одной учётной записью `sandbox-agent`, а её пароль лежал в `.env` на машине
 * разработчика. Теперь у каждого человека свой бот `<логин>-agent`, а пароль администратора Gitea остаётся
 * на сервере — в этом сервисе. Агент приходит с личным ключом своего человека и получает короткоживущий
 * токен бота: в истории репозитория видно, чей агент что сделал, а отзыв ключа обрывает и токен.
 *
 * Права бота ровно те же, что были у общего агента: писать ветки и открывать PR. В `main` он не пишет —
 * это защита ветки, а не доверие.
 */
import { service } from './db.ts';

const GITEA_URL = process.env.GITEA_URL ?? 'http://gitea:3000';
const REPO = process.env.GITEA_REPO ?? 'platform/internal-tools';
/** Агент работает с машины человека, поэтому адрес репозитория — публичный, а не внутренний `gitea:3000`. */
const GITEA_PUBLIC = process.env.GITEA_PUBLIC_URL ?? 'http://localhost:13000';
const ADMIN_USER = process.env.GITEA_ADMIN_USER ?? '';
const ADMIN_PASSWORD = process.env.GITEA_ADMIN_PASSWORD ?? '';
/** Токен живёт часы: хватает на «собрал → превью → PR», но не остаётся жить на ноутбуке. */
export const FORGE_TOKEN_HOURS = Number(process.env.FORGE_TOKEN_HOURS ?? 4);
const TOKEN_PREFIX = 'sandbox-mcp';
/** Бот принадлежит человеку и называется по нему: в истории git видно, чей это агент. */
export const botOf = (owner: string) => `${owner}-agent`;

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

function adminAuth(): string {
  if (!ADMIN_USER || !ADMIN_PASSWORD) throw new Error('у сервиса личности нет учётной записи администратора Gitea');
  return Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64');
}

async function gitea<T>(path: string, init?: { method: string; body?: unknown }): Promise<T | null> {
  const res = await fetch(`${GITEA_URL}/api/v1${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Basic ${adminAuth()}`, 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Gitea ${init?.method ?? 'GET'} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/** Бот существует и допущен к репозиторию. Пароль ему не нужен: он входит только токеном. */
async function ensureBot(owner: string): Promise<string> {
  const bot = botOf(owner);
  const found = await gitea<{ login: string }>(`/users/${encodeURIComponent(bot)}`);
  if (!found) {
    await gitea('/admin/users', {
      method: 'POST',
      body: {
        username: bot,
        email: `${bot}@sandbox.local`,
        password: `${TOKEN_PREFIX}-${crypto.randomUUID()}`,
        must_change_password: false,
        visibility: 'private',
      },
    });
    log({ type: 'forge_bot_created', owner, bot });
  }
  // Право писать ветки в репозиторий песочницы. `main` закрыт защитой ветки для всех, включая ботов.
  await gitea(`/repos/${REPO}/collaborators/${encodeURIComponent(bot)}`, { method: 'PUT', body: { permission: 'write' } });
  return bot;
}

/** Убрать токены бота: и в Gitea, и в учёте. Возвращает, сколько убрано. */
async function dropTokens(owner: string, bot: string, reason: string): Promise<number> {
  const live = await service.query<{ id: number; token_id: string }>(
    'SELECT id, token_id FROM identity.forge_tokens WHERE owner = $1 AND revoked_at IS NULL',
    [owner],
  );
  let gone = 0;
  for (const row of live.rows) {
    try {
      await gitea(`/users/${encodeURIComponent(bot)}/tokens/${row.token_id}`, { method: 'DELETE' });
    } catch (e) {
      log({ type: 'forge_token_delete_failed', owner, token_id: row.token_id, error: (e as Error).message });
    }
    await service.query('UPDATE identity.forge_tokens SET revoked_at = now() WHERE id = $1', [row.id]);
    gone++;
  }
  if (gone) log({ type: 'forge_tokens_dropped', owner, count: gone, reason });
  return gone;
}

export interface ForgeToken {
  user: string;
  token: string;
  repo_url: string;
  expires_at: string;
}

/**
 * Токен для агента этого человека. Прежний токен отзывается: один человек — один живой токен,
 * поэтому украденный со старой машины перестаёт работать при следующем входе.
 */
export async function forgeToken(owner: string): Promise<ForgeToken> {
  const bot = await ensureBot(owner);
  await dropTokens(owner, bot, 'перевыпуск');

  const name = `${TOKEN_PREFIX}-${Date.now()}`;
  const created = await gitea<{ id: number; sha1: string }>(`/users/${encodeURIComponent(bot)}/tokens`, {
    method: 'POST',
    // read:user — чтобы деплоер мог проверить, что это действительно учётная запись Gitea, а не чужой токен.
    body: { name, scopes: ['write:repository', 'write:issue', 'read:user'] },
  });
  if (!created?.sha1) throw new Error('Gitea не выдала токен агенту');

  const expires = new Date(Date.now() + FORGE_TOKEN_HOURS * 3600_000);
  await service.query(
    'INSERT INTO identity.forge_tokens (owner, bot, token_id, token_name, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [owner, bot, created.id, name, expires],
  );
  log({ type: 'forge_token_issued', owner, bot, expires_at: expires.toISOString() });
  return { user: bot, token: created.sha1, repo_url: `${GITEA_PUBLIC}/${REPO}.git`, expires_at: expires.toISOString() };
}

/**
 * Скрипт рабочей копии (`infra/remote.sh`) из закрытого репозитория. Иначе курица и яйцо: чтобы развернуть
 * копию на ноутбуке, нужен доступ к репозиторию, а его выдаёт как раз этот сервис. Учётка администратора
 * остаётся здесь — на ноутбук уезжает только личный ключ человека.
 */
export async function remoteScript(): Promise<string> {
  const res = await fetch(`${GITEA_URL}/api/v1/repos/${REPO}/raw/infra/remote.sh?ref=main`, {
    headers: { Authorization: `Basic ${adminAuth()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Gitea не отдала infra/remote.sh: ${res.status}`);
  return res.text();
}

/** Отзыв ключа человека обрывает и доступ его агента к репозиторию. */
export async function dropForgeTokens(owner: string, reason: string): Promise<number> {
  return dropTokens(owner, botOf(owner), reason);
}

/** Просроченные токены удаляются сами: срок должен что-то значить, а не украшать ответ. */
export async function sweepForgeTokens(): Promise<number> {
  const { rows } = await service.query<{ owner: string }>(
    'SELECT DISTINCT owner FROM identity.forge_tokens WHERE revoked_at IS NULL AND expires_at <= now()',
  );
  let gone = 0;
  for (const r of rows) gone += await dropTokens(r.owner, botOf(r.owner), 'истёк срок');
  return gone;
}
