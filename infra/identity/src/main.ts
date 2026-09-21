/**
 * Личность песочницы (шаг Б1). Единственное место, где человек доказывает, кто он: вход через IdP компании
 * (на стенде — Keycloak), сессия в куке на домене песочницы, и на каждый запрос — короткий подписанный JWT
 * «личность» для тула и гейтвея.
 *
 * Traefik спрашивает у нас разрешение на каждый запрос к главной и тулам (ForwardAuth):
 *   нет сессии            → 302 на вход, до тула запрос не доходит;
 *   есть сессия           → 200 и заголовок X-Sandbox-Identity: JWT на минуты, с sub, groups, channel и aud
 *                           ровно того инстанса, куда идёт запрос. Свой X-Sandbox-Identity от клиента Traefik вырезает.
 * Тул личность не придумывает: он пересылает этот JWT в гейтвей, а гейтвей проверяет подпись и aud.
 *
 * Без npm-зависимостей, кроме jose (подпись и проверка JWT): node:http, fetch.
 */
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash, randomBytes, createPublicKey } from 'node:crypto';
import { SignJWT, jwtVerify, exportJWK, exportPKCS8, importPKCS8, generateKeyPair, createRemoteJWKSet, type JWTPayload } from 'jose';
import { bootstrap, groupsOf, waitForKeycloak } from './keycloak.ts';
import { auditKey, checkKey, GRACE_HOURS, issueKey, listKeys, revokeAll, revokeKey, type KeyRow } from './keys.ts';
import { loadDirectory, ADMINS, APPROVERS } from '@sandbox/manifest';

const PORT = Number(process.env.PORT ?? 8080);
const DOMAIN = process.env.SANDBOX_DOMAIN ?? 'tools.localhost';
const PUBLIC_PORT = process.env.SANDBOX_PUBLIC_PORT ?? '18000';
const BASE = `http://${DOMAIN}:${PUBLIC_PORT}`;
const SELF = `http://id.${DOMAIN}:${PUBLIC_PORT}`;
const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://keycloak:8080';
const KEYCLOAK_PUBLIC = process.env.KEYCLOAK_PUBLIC_URL ?? `http://auth.${DOMAIN}:${PUBLIC_PORT}`;
const REALM = process.env.KEYCLOAK_REALM ?? 'sandbox';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'sandbox';
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const DIRECTORY_PATH = process.env.DIRECTORY_PATH ?? '/registry/directory.yaml';
const HUMAN = process.env.SANDBOX_HUMAN || 'ivan.petrov';
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://gateway:8080';
const GATEWAY_TOKEN = process.env.GATEWAY_IDENTITY_TOKEN ?? '';
const SESSION_HOURS = Number(process.env.IDENTITY_SESSION_HOURS ?? 8);
/** Личность живёт минуты: украденный заголовок бесполезен почти сразу. */
const IDENTITY_TTL = process.env.IDENTITY_TOKEN_TTL ?? '2m';
const SESSION_COOKIE = 'sandbox_session';
const FLOW_COOKIE = 'sandbox_login';
const ISSUER = `${SELF}/`;

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

// ---------- ключ подписи: один на стенд, переживает перезапуск -----------------------------------

mkdirSync(STATE_DIR, { recursive: true });
const KEY_FILE = join(STATE_DIR, 'identity-key.pem');
const KID = 'identity';

async function loadKey() {
  if (!existsSync(KEY_FILE)) {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    writeFileSync(KEY_FILE, await exportPKCS8(privateKey), { mode: 0o600 });
    log({ type: 'key_created' });
  }
  const priv = await importPKCS8(readFileSync(KEY_FILE, 'utf8'), 'RS256', { extractable: true });
  const pubKey = createPublicKey(priv as never);
  const jwk = await exportJWK(pubKey);
  return { priv, pubKey, jwks: { keys: [{ ...jwk, alg: 'RS256', use: 'sig', kid: KID }] } };
}
const { priv, pubKey, jwks } = await loadKey();

const sign = (payload: JWTPayload, audience: string, ttl: string) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(priv);

const verify = (token: string, audience: string) => jwtVerify(token, pubKey, { issuer: ISSUER, audience });

// ---------- IdP ----------------------------------------------------------------------------------

const idpJwks = createRemoteJWKSet(new URL(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/certs`));
const authorizeUrl = `${KEYCLOAK_PUBLIC}/realms/${REALM}/protocol/openid-connect/auth`;
const tokenUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`;
const logoutUrl = `${KEYCLOAK_PUBLIC}/realms/${REALM}/protocol/openid-connect/logout`;
const deviceUrl = `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth/device`;
/** Сколько живёт вход агента: он лежит файлом на машине человека, поэтому недолго. */
const MCP_SESSION_HOURS = Number(process.env.IDENTITY_MCP_SESSION_HOURS ?? 12);

// ---------- HTTP ---------------------------------------------------------------------------------

const cookies = (req: http.IncomingMessage): Record<string, string> => Object.fromEntries(
  (req.headers.cookie ?? '').split(';').map((p) => p.trim().split('=')).filter(([k, v]) => k && v !== undefined)
    .map(([k, ...v]) => [k!, decodeURIComponent(v.join('='))]),
);
const setCookie = (name: string, value: string, opts: string) => `${name}=${encodeURIComponent(value)}; ${opts}`;
const sessionCookie = (value: string, maxAge: number) =>
  setCookie(SESSION_COOKIE, value, `Domain=${DOMAIN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);

/** Инстанс, к которому идёт запрос: manager-board.tools.localhost → manager-board, сам домен → portal. */
function audienceOf(host: string): string {
  const name = host.split(':')[0]!.replace(new RegExp(`\\.${DOMAIN.replace(/\./g, '\\.')}$`), '');
  return !name || name === DOMAIN ? 'portal' : name;
}

const redirect = (res: http.ServerResponse, to: string, cookie?: string) =>
  res.writeHead(302, { Location: to, ...(cookie ? { 'Set-Cookie': cookie } : {}) }).end();

/** Куда вернуть после входа: только адрес внутри песочницы. */
function safeNext(raw: string | null): string {
  if (!raw) return BASE;
  try {
    const u = new URL(raw);
    const ok = u.hostname === DOMAIN || u.hostname.endsWith(`.${DOMAIN}`);
    return ok ? u.toString() : BASE;
  } catch {
    return BASE;
  }
}

interface Session extends JWTPayload { sub: string; name?: string; groups?: string[]; channel?: 'web' | 'mcp' }

/**
 * Сессия человека: кука из браузера (канал web) или вход агента заголовком Authorization (канал mcp).
 * Агент получает её через device flow — человек подтверждает вход в браузере, ключей у агента нет.
 */
async function sessionOf(req: http.IncomingMessage): Promise<Session | null> {
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const raw = cookies(req)[SESSION_COOKIE] ?? (bearer || undefined);
  if (!raw) return null;
  try {
    const { payload } = await verify(raw, 'sandbox-session');
    return payload as Session;
  } catch {
    return null;
  }
}

/**
 * Все группы человека: зеркало IdP (отдел, должность) плюс группы песочницы, которыми управляет администратор.
 * Кэш короткий — исключение из группы действует на следующем вызове, ключ перевыпускать не нужно.
 */
const groupCache = new Map<string, { at: number; groups: string[] }>();
async function sandboxGroups(login: string): Promise<string[]> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/groups/of/${encodeURIComponent(login)}`, {
    headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }, signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`гейтвей: группы ${res.status}`);
  return ((await res.json()) as { groups: string[] }).groups;
}

async function freshGroups(login: string): Promise<string[]> {
  const hit = groupCache.get(login);
  if (hit && Date.now() - hit.at < 60_000) return hit.groups;
  const [idp, own] = await Promise.all([
    groupsOf(KEYCLOAK_URL, REALM, login).catch(() => [] as string[]),
    sandboxGroups(login).catch((e: Error) => {
      log({ type: 'groups_failed', login, error: e.message });
      return [] as string[];
    }),
  ]);
  const groups = [...new Set([...idp, ...own])];
  groupCache.set(login, { at: Date.now(), groups });
  return groups;
}

/**
 * Можно ли этому человеку открыть этот инстанс. Решает гейтвей (он же проверит повторно на вызове),
 * здесь — чтобы отказ случился до тула. Кэш короткий: доступ меняют на главной без передеплоя.
 */
const accessCache = new Map<string, { at: number; verdict: Verdict }>();
async function accessCheck(instance: string, who: { actor: string; groups: string[]; channel: string }): Promise<Verdict> {
  const key = `${instance}|${who.actor}|${who.channel}`;
  const hit = accessCache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.verdict;
  const url = `${GATEWAY_URL}/v1/admin/access-check?instance=${encodeURIComponent(instance)}&login=${encodeURIComponent(who.actor)}`
    + `&groups=${encodeURIComponent(who.groups.join(','))}&channel=${who.channel}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`гейтвей: проверка доступа ${res.status}`);
  const verdict = (await res.json()) as Verdict;
  accessCache.set(key, { at: Date.now(), verdict });
  return verdict;
}

interface Verdict { allowed: boolean; reason: string; owner: string | null }

/** Страница отказа: человек должен понимать, у кого просить доступ, а не видеть голый 403. */
function denied(res: http.ServerResponse, instance: string, verdict: Verdict, html: boolean) {
  if (!html) return void json(res, 403, { error: 'forbidden', message: verdict.reason, owner: verdict.owner });
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><meta charset="utf-8"><title>Нет доступа</title>
     <body style="font-family:system-ui;max-width:520px;margin:15vh auto;padding:0 16px">
     <h2 style="margin-bottom:4px">Тул ${instance} вам не открыт</h2>
     <p style="color:#666">${verdict.reason}</p>
     <p><a href="${BASE}/tools/${encodeURIComponent(instance.split('--')[0]!)}">Страница тула на главной</a> — там кнопка «Попросить доступ».</p>`,
  );
}

/** Точка ForwardAuth: Traefik спрашивает про каждый запрос к главной и тулам. */
async function forwardAuth(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = req.headers['x-forwarded-host'] as string | undefined ?? DOMAIN;
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  const uri = (req.headers['x-forwarded-uri'] as string | undefined) ?? '/';
  const target = `${proto}://${host}${uri}`;
  // Личный ключ MCP: работает вместо входа в браузере, права перечитываются на каждом вызове.
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  if (bearer.startsWith('sbx_')) {
    const key = await checkKey(bearer, { agent: req.headers['user-agent'], ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() });
    if (!key) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ error: 'unauthorized', message: 'ключ MCP не годится: отозван, истёк или неверен. Обновите подключение' }));
      return;
    }
    const groups = await freshGroups(key.owner);
    const aud = audienceOf(host);
    if (aud !== 'portal') {
      const verdict = await accessCheck(aud, { actor: key.owner, groups, channel: 'mcp' });
      if (!verdict.allowed) {
        await auditKey({ actor: key.owner, operation: 'access.denied', allowed: false, reason: verdict.reason, tool: aud });
        return void denied(res, aud, verdict, false);
      }
    }
    const identity = await sign({ sub: key.owner, groups, channel: 'mcp', key: key.prefix }, aud, IDENTITY_TTL);
    res.writeHead(200, { 'X-Sandbox-Identity': identity }).end();
    return;
  }

  const session = await sessionOf(req);
  if (!session) {
    // Выход: браузер уходит на вход, а фоновые запросы (fetch из UI) получают 401 и сами покажут «войдите».
    const wantsHtml = (req.headers.accept ?? '').includes('text/html');
    if (!wantsHtml) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: 'unauthorized', login: `${SELF}/login` }));
      return;
    }
    redirect(res, `${SELF}/login?next=${encodeURIComponent(target)}`);
    return;
  }
  const groups = await freshGroups(session.sub);
  const aud = audienceOf(host);
  const channel = session.channel ?? 'web';
  // Главная открыта всем вошедшим — она и показывает, что человеку доступно; тул проверяем поимённо.
  if (aud !== 'portal') {
    const verdict = await accessCheck(aud, { actor: session.sub, groups, channel });
    if (!verdict.allowed) {
      await auditKey({ actor: session.sub, operation: 'access.denied', allowed: false, reason: verdict.reason, tool: aud });
      return void denied(res, aud, verdict, (req.headers.accept ?? '').includes('text/html'));
    }
  }
  const identity = await sign({ sub: session.sub, name: session.name, groups, channel }, aud, IDENTITY_TTL);
  res.writeHead(200, { 'X-Sandbox-Identity': identity }).end();
}

async function login(url: URL, res: http.ServerResponse) {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomUUID();
  const next = safeNext(url.searchParams.get('next'));
  const flow = await sign({ state, verifier, next }, 'sandbox-login', '10m');
  const params = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code', scope: 'openid profile',
    redirect_uri: `${SELF}/callback`, state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  redirect(res, `${authorizeUrl}?${params}`, setCookie(FLOW_COOKIE, flow, `Domain=${DOMAIN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`));
}

async function callback(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
  const raw = cookies(req)[FLOW_COOKIE];
  if (!raw) return fail(res, 400, 'вход начат слишком давно — попробуйте ещё раз');
  let flow: { state: string; verifier: string; next: string };
  try {
    flow = (await verify(raw, 'sandbox-login')).payload as unknown as typeof flow;
  } catch {
    return fail(res, 400, 'подделанный или просроченный вход');
  }
  if (url.searchParams.get('state') !== flow.state) return fail(res, 400, 'state не совпал');
  const code = url.searchParams.get('code');
  if (!code) return fail(res, 400, `IdP отказал: ${url.searchParams.get('error') ?? 'нет кода'}`);

  const token = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CLIENT_ID, code,
      redirect_uri: `${SELF}/callback`, code_verifier: flow.verifier,
    }),
  });
  if (!token.ok) return fail(res, 502, `IdP не выдал токен: ${token.status}`);
  const { id_token: idToken } = (await token.json()) as { id_token: string };
  const { payload } = await jwtVerify(idToken, idpJwks, { audience: CLIENT_ID });
  const username = (payload.preferred_username as string | undefined) ?? String(payload.sub);
  const groups = ((payload.groups as string[] | undefined) ?? []).map((g) => g.replace(/^\//, ''));

  const session = await sign({ sub: username, name: payload.name, groups, channel: 'web' }, 'sandbox-session', `${SESSION_HOURS}h`);
  log({ type: 'login', actor: username, groups });
  redirect(res, flow.next, sessionCookie(session, SESSION_HOURS * 3600));
}

/** Вход агента: MCP-хост просит ссылку, человек подтверждает её в браузере, дальше хост забирает сессию. */
async function deviceStart(res: http.ServerResponse) {
  // PKCE обязателен и здесь: verifier остаётся у нас, наружу уходит только подписанный handle.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const r = await fetch(deviceUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'openid profile', code_challenge: challenge, code_challenge_method: 'S256' }),
  });
  if (!r.ok) return json(res, 502, { error: `IdP не начал вход: ${r.status}` });
  const d = (await r.json()) as { device_code: string; user_code: string; verification_uri_complete?: string; verification_uri: string; interval?: number; expires_in: number };
  // Ссылку подставляем публичную: агент открывает её в браузере человека.
  const verify_url = (d.verification_uri_complete ?? d.verification_uri).replace(KEYCLOAK_URL, KEYCLOAK_PUBLIC);
  const handle = await sign({ device_code: d.device_code, verifier }, 'sandbox-device', `${d.expires_in}s`);
  log({ type: 'device_start', user_code: d.user_code });
  json(res, 200, { device_code: handle, user_code: d.user_code, verification_url: verify_url, interval: d.interval ?? 5, expires_in: d.expires_in });
}

async function devicePoll(req: http.IncomingMessage, res: http.ServerResponse) {
  const body = await readJson(req);
  const handle = typeof body.device_code === 'string' ? body.device_code : '';
  if (!handle) return json(res, 400, { error: 'нужен device_code' });
  let flow: { device_code: string; verifier: string };
  try {
    flow = (await verify(handle, 'sandbox-device')).payload as unknown as typeof flow;
  } catch {
    return json(res, 400, { status: 'expired_token' });
  }
  const r = await fetch(tokenUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: flow.device_code, code_verifier: flow.verifier,
    }),
  });
  const data = (await r.json()) as { id_token?: string; error?: string };
  if (!r.ok) return json(res, r.status === 400 && data.error === 'authorization_pending' ? 202 : 400, { status: data.error ?? 'error' });
  const { payload } = await jwtVerify(data.id_token!, idpJwks, { audience: CLIENT_ID });
  const username = (payload.preferred_username as string | undefined) ?? String(payload.sub);
  const groups = ((payload.groups as string[] | undefined) ?? []).map((g) => g.replace(/^\//, ''));
  const session = await sign({ sub: username, name: payload.name, groups, channel: 'mcp' }, 'sandbox-session', `${MCP_SESSION_HOURS}h`);
  log({ type: 'device_login', actor: username, groups });
  // Вход одной командой: человек только что подтвердил его в браузере — сразу отдаём личный ключ, он живёт дольше.
  if (body.want_key === true) {
    const { key, row } = await issueKey({ owner: username, name: typeof body.name === 'string' ? body.name : 'вход из терминала', by: username });
    return json(res, 200, { session, key, prefix: row.prefix, expires_at: row.expires_at, actor: username, expires_in: MCP_SESSION_HOURS * 3600 });
  }
  json(res, 200, { session, actor: username, expires_in: MCP_SESSION_HOURS * 3600 });
}

/**
 * Кабинет ключей. Выпускать и отзывать можно только из браузера (канал web): агент своим ключом новых ключей
 * себе не выпишет. Администратор песочницы может отозвать чужие ключи — например, при утечке.
 */
async function keysApi(req: http.IncomingMessage, url: URL, res: http.ServerResponse) {
  const session = await sessionOf(req);
  if (!session || (session.channel ?? 'web') !== 'web') return json(res, 401, { error: 'нужен вход в браузере' });
  const me = session.sub;
  const isAdmin = (await freshGroups(me)).includes(ADMINS);
  const view = (k: KeyRow) => ({
    prefix: k.prefix, name: k.name, owner: k.owner, created_at: k.created_at, created_by: k.created_by,
    expires_at: k.expires_at, last_used_at: k.last_used_at, last_agent: k.last_agent, last_ip: k.last_ip,
    revoked_at: k.revoked_at, revoked_by: k.revoked_by, revoke_reason: k.revoke_reason,
  });

  if (req.method === 'GET' && url.pathname === '/keys') {
    const owner = url.searchParams.get('owner') ?? me;
    if (owner !== me && !isAdmin) return json(res, 403, { error: 'чужие ключи видит только администратор песочницы' });
    return json(res, 200, { owner, keys: (await listKeys(owner)).map(view), grace_hours: GRACE_HOURS });
  }

  if (req.method === 'POST' && url.pathname === '/keys') {
    const b = await readJson(req);
    const owner = typeof b.owner === 'string' && b.owner !== me ? b.owner : me;
    if (owner !== me && !isAdmin) return json(res, 403, { error: 'выпускать ключи другому может только администратор' });
    const name = (typeof b.name === 'string' && b.name.trim()) || 'без названия';
    // Перевыпуск: прежний ключ ещё поработает, чтобы агент не умер посреди работы.
    const replace = typeof b.replace === 'string' ? b.replace : null;
    const { key, row } = await issueKey({ owner, name, by: me });
    if (replace) await revokeKey({ prefix: replace, by: me, owner: isAdmin ? undefined : me, reason: 'перевыпуск', graceHours: b.now === true ? 0 : GRACE_HOURS });
    return json(res, 200, { key, ...view(row), replaced: replace, grace_hours: b.now === true ? 0 : GRACE_HOURS });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/keys/')) {
    const prefix = url.pathname.slice('/keys/'.length);
    if (prefix === 'all') {
      const owner = url.searchParams.get('owner') ?? me;
      if (owner !== me && !isAdmin) return json(res, 403, { error: 'отзывать чужие ключи может только администратор' });
      return json(res, 200, { revoked: await revokeAll({ owner, by: me, reason: url.searchParams.get('reason') ?? 'отзыв всех ключей' }) });
    }
    const ok = await revokeKey({ prefix, by: me, owner: isAdmin ? undefined : me, reason: url.searchParams.get('reason') ?? 'отозван владельцем' });
    if (!ok) await auditKey({ actor: me, operation: 'key.revoke', allowed: false, reason: `ключ ${prefix}: не найден или чужой` });
    return json(res, ok ? 200 : 404, ok ? { revoked: prefix } : { error: 'ключ не найден или не ваш' });
  }
  json(res, 405, { error: 'нельзя' });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 8000) throw new Error('слишком большой запрос');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const json = (res: http.ServerResponse, code: number, data: unknown) =>
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));

function fail(res: http.ServerResponse, code: number, message: string) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><meta charset="utf-8"><title>Вход</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto">
     <h2>Не удалось войти</h2><p style="color:#666">${message}</p><p><a href="${SELF}/login">Попробовать снова</a></p>`,
  );
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', SELF);
  try {
    if (url.pathname === '/healthz') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    if (url.pathname === '/auth') return void (await forwardAuth(req, res));
    if (url.pathname === '/login') return void (await login(url, res));
    if (url.pathname === '/callback') return void (await callback(req, url, res));
    if (url.pathname === '/keys' || url.pathname.startsWith('/keys/')) return void (await keysApi(req, url, res));
    if (req.method === 'POST' && url.pathname === '/device/start') return void (await deviceStart(res));
    if (req.method === 'POST' && url.pathname === '/device/poll') return void (await devicePoll(req, res));
    if (url.pathname === '/logout') {
      const params = new URLSearchParams({ client_id: CLIENT_ID, post_logout_redirect_uri: safeNext(url.searchParams.get('next')) });
      return void redirect(res, `${logoutUrl}?${params}`, sessionCookie('', 0));
    }
    // Гейтвей и тулы проверяют подпись личности по этому ключу.
    if (url.pathname === '/jwks.json') {
      return void res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300' }).end(JSON.stringify(jwks));
    }
    // Кто я сейчас — для отладки и для страницы входа.
    if (url.pathname === '/me') {
      const s = await sessionOf(req);
      return void res.writeHead(s ? 200 : 401, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(s ? { actor: s.sub, name: s.name, groups: s.groups } : { error: 'unauthorized' }));
    }
    res.writeHead(404).end();
  } catch (e) {
    log({ type: 'error', path: url.pathname, error: (e as Error).message });
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify({ error: (e as Error).message }));
  }
});

// ---------- запуск: сначала IdP, потом приём запросов --------------------------------------------

const directory = loadDirectory(DIRECTORY_PATH, HUMAN);
const people: Record<string, string[]> = { [HUMAN]: [ADMINS, APPROVERS] };
for (const [login, p] of Object.entries(directory.people)) {
  if (p.active === false) continue; // ушедших в IdP не заводим: вход им не нужен
  people[login] ??= [];
}
for (const [name, group] of Object.entries(directory.groups)) {
  for (const m of group.members) (people[m] ??= []).push(name);
}

await waitForKeycloak(KEYCLOAK_URL);
await bootstrap({
  url: KEYCLOAK_URL, realm: REALM, clientId: CLIENT_ID,
  redirectUris: [`${SELF}/callback`, `${BASE}/*`, `http://*.${DOMAIN}:${PUBLIC_PORT}/*`],
  human: HUMAN,
  humanTempPassword: process.env.KEYCLOAK_HUMAN_PASSWORD ?? 'sandbox',
  demoPassword: process.env.KEYCLOAK_DEMO_PASSWORD ?? 'sandbox',
  people,
});
server.listen(PORT, () => log({ type: 'started', port: PORT, issuer: ISSUER, idp: KEYCLOAK_PUBLIC, people: Object.keys(people).length }));
