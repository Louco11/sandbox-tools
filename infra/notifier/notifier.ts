/**
 * Уведомления: единая точка, через которую платформа сообщает людям о событиях — тул простаивает и будет удалён,
 * срок подходит к потолку автопродления, выкатка упала, PR ждёт одобрения, превью убрано.
 *
 * Отправители (уборщик, деплоер) пишут «кому» как в справочнике — логин, группу или e-mail автора коммита. Кому
 * доставить на самом деле, решает гейтвей по справочнику: ушёл из компании — руководителю, группа — участникам,
 * не нашлось никого — администраторам песочницы. Одно событие (key) доставляется один раз.
 *
 * Канал на стенде — заглушка-почтовый ящик: входящие человека на главной (/inbox). Настоящий канал (мессенджер или
 * почта компании) — решение человека (docs/roadmap.md, раздел 4); он подключается в deliver() и получает сеть наружу.
 * Без npm-зависимостей: node:http, fetch, файл журнала в томе.
 */
import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const PORT = Number(process.env.PORT ?? 8080);
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://gateway:8080';
const GATEWAY_TOKEN = process.env.GATEWAY_NOTIFIER_TOKEN ?? '';
const KEEP_DAYS = 90;
const ADMINS = 'sandbox-admins';

/** Кто может слать и кто читать: у каждого сервиса свой токен. Главная и шлёт (заявки на доступ), и читает. */
const SENDERS = { reaper: process.env.NOTIFY_REAPER_TOKEN, deployer: process.env.NOTIFY_DEPLOYER_TOKEN, portal: process.env.NOTIFY_PORTAL_TOKEN };
const READERS = { portal: process.env.NOTIFY_PORTAL_TOKEN };

interface Message {
  id: string; at: string; to: string; from: string; event: string;
  subject: string; text: string; link: string | null; note: string | null; read: boolean;
}

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

// ---------- хранилище: журнал сообщений и ключи уже доставленных событий ---------------------------

mkdirSync(STATE_DIR, { recursive: true });
const MESSAGES = join(STATE_DIR, 'messages.jsonl');
const KEYS = join(STATE_DIR, 'keys.json');
const since = Date.now() - KEEP_DAYS * 86_400_000;

const messages: Message[] = existsSync(MESSAGES)
  ? readFileSync(MESSAGES, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Message).filter((m) => new Date(m.at).getTime() > since)
  : [];
const keys: Record<string, string> = Object.fromEntries(
  Object.entries(existsSync(KEYS) ? (JSON.parse(readFileSync(KEYS, 'utf8')) as Record<string, string>) : {}).filter(([, at]) => new Date(at).getTime() > since),
);
// Журнал переписывается при старте: старше KEEP_DAYS — удаляется, прочитанное — сохраняется.
const persist = () => writeFileSync(MESSAGES, messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''));
persist();
writeFileSync(KEYS, JSON.stringify(keys));

// ---------- кому доставить ----------------------------------------------------------------------

interface Resolved { logins: string[]; kind: string; note: string | null }

async function resolve(name: string): Promise<Resolved> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/directory/resolve?name=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` }, signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`гейтвей: справочник ответил ${res.status}`);
  return (await res.json()) as Resolved;
}

/** Каждому получателю — с пояснением, почему ему (вместо ушедшего владельца, как участнику группы…). */
async function recipients(to: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const lost: string[] = [];
  for (const name of new Set(to)) {
    const r = await resolve(name);
    if (!r.logins.length) lost.push(r.note ?? name);
    for (const l of r.logins) if (!out.has(l)) out.set(l, r.kind === 'group' ? `вы в группе ${name}` : r.note);
  }
  // Никого не нашлось — событие не должно пропасть молча: его получают администраторы песочницы.
  if (!out.size) {
    for (const l of (await resolve(ADMINS)).logins) out.set(l, `${lost.join('; ') || 'получатель не указан'} — вам как администратору песочницы`);
  }
  return out;
}

/** Доставка. На стенде — только входящие на главной; здесь подключается мессенджер или почта компании. */
function deliver(m: Message): void {
  messages.push(m);
  appendFileSync(MESSAGES, JSON.stringify(m) + '\n');
}

// ---------- HTTP ---------------------------------------------------------------------------------

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
function roleOf(req: http.IncomingMessage, roles: Record<string, string | undefined>): string | null {
  const given = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  for (const [role, token] of Object.entries(roles)) if (token && given && same(given, token)) return role;
  return null;
}

async function body(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new Error('слишком большое сообщение');
  }
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const LOGIN = /^[a-z][a-z0-9._-]{1,63}$/;

function send(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

async function notify(from: string, b: Record<string, unknown>) {
  const to = Array.isArray(b.to) ? b.to.map((x) => str(x, 200)).filter((x): x is string => !!x) : [];
  const event = str(b.event, 40);
  const subject = str(b.subject, 200);
  const key = str(b.key, 300);
  if (!event || !subject || !key) return { status: 400, data: { error: 'нужны event, subject, key' } };
  if (keys[key]) return { status: 200, data: { duplicate: true, key } };

  const who = await recipients(to);
  const at = new Date().toISOString();
  for (const [login, note] of who) {
    deliver({ id: randomUUID(), at, to: login, from, event, subject, text: str(b.text, 4000) ?? '', link: str(b.link, 500), note, read: false });
  }
  keys[key] = at;
  writeFileSync(KEYS, JSON.stringify(keys));
  log({ type: 'notified', from, event, key, to, delivered: [...who.keys()] });
  return { status: 200, data: { key, delivered: [...who.keys()] } };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://notifier');
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, messages: messages.length });

    if (req.method === 'POST' && url.pathname === '/notify') {
      const from = roleOf(req, SENDERS);
      if (!from) return send(res, 401, { error: 'нужен токен отправителя' });
      const r = await notify(from, await body(req));
      return send(res, r.status, r.data);
    }

    // Входящие человека — для главной. Личность до шага Б1 — заглушка SSO главной.
    if (url.pathname === '/inbox') {
      if (!roleOf(req, READERS)) return send(res, 401, { error: 'нужен токен читателя' });
      const to = url.searchParams.get('to') ?? '';
      if (!LOGIN.test(to)) return send(res, 400, { error: 'нужен to — логин' });
      const mine = messages.filter((m) => m.to === to);
      if (req.method === 'POST') {
        for (const m of mine) m.read = true;
        persist();
        return send(res, 200, { read: mine.length });
      }
      return send(res, 200, { unread: mine.filter((m) => !m.read).length, messages: mine.slice(-100).reverse() });
    }
    send(res, 404, { error: 'not_found' });
  } catch (e) {
    log({ type: 'error', path: url.pathname, error: (e as Error).message });
    send(res, 502, { error: (e as Error).message });
  }
}).listen(PORT, () => log({ type: 'started', port: PORT, messages: messages.length }));
