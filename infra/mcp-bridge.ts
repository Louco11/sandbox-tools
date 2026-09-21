/**
 * Мост stdio → Streamable HTTP для локальных MCP-хостов (Claude Desktop, Claude Code, Cursor).
 *   node infra/mcp-bridge.ts <url>
 *
 * Личность человека берётся не из аргумента. Сначала мост ищет личный ключ MCP (переменная окружения, Keychain
 * или ~/.sandbox — его кладёт `bin/sandbox-mcp login`), а если ключа нет — сам проводит вход через браузер
 * (device flow сервиса identity) и хранит сессию. Кто это, решает IdP, а не тот, кто запустил мост.
 *
 * Сообщения пересылаются как есть, поэтому возможности хоста (включая MCP Apps) доходят до тула без изменений.
 * Если тул передеплоили и сессия пропала, мост сам повторяет initialize и досылает запрос.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadKey, KEY_ENV } from './mcp-key.ts';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [urlArg] = process.argv.slice(2);
if (!urlArg) {
  console.error('usage: node infra/mcp-bridge.ts <url>');
  process.exit(2);
}
const url: string = urlArg;

const log = (msg: string) => console.error(`[bridge ${new URL(url).host}] ${msg}`);
const REINIT_ID = '__bridge_reinit__';

// ---------- вход человека: device flow через сервис identity -------------------------------------

const host = new URL(url).host;                       // <тул>.<домен>:<порт>
const domain = host.split('.').slice(1).join('.');    // <домен>:<порт>
const IDENTITY = `http://id.${domain}`;
const SESSION_DIR = join(process.env.SANDBOX_HOME ?? homedir(), '.sandbox');
const SESSION_FILE = join(SESSION_DIR, `${domain.replace(/[^a-z0-9.-]/gi, '_')}.json`);

interface Stored { session: string; actor: string; exp: number }

function readSession(): Stored | null {
  try {
    const s = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as Stored;
    return s.exp > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

/** Человек подтверждает вход в своём браузере: у агента нет ни пароля, ни ключа (ключи — шаг Б2). */
async function deviceLogin(): Promise<Stored> {
  const start = await fetch(`${IDENTITY}/device/start`, { method: 'POST' });
  if (!start.ok) throw new Error(`сервис личности не начал вход: ${start.status}`);
  const d = (await start.json()) as { device_code: string; user_code: string; verification_url: string; interval: number; expires_in: number };
  log(`нужен вход: откройте ${d.verification_url} и подтвердите код ${d.user_code}`);
  spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [d.verification_url], { stdio: 'ignore', detached: true }).unref();

  const until = Date.now() + d.expires_in * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, d.interval * 1000));
    const res = await fetch(`${IDENTITY}/device/poll`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device_code: d.device_code }),
    });
    if (res.status === 202) continue;
    if (!res.ok) throw new Error(`вход не подтверждён: ${(await res.json() as { status?: string }).status ?? res.status}`);
    const ok = (await res.json()) as { session: string; actor: string; expires_in: number };
    const stored: Stored = { session: ok.session, actor: ok.actor, exp: Date.now() + ok.expires_in * 1000 };
    mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(SESSION_FILE, JSON.stringify(stored), { mode: 0o600 });
    log(`вход выполнен: ${ok.actor}`);
    return stored;
  }
  throw new Error('вход не подтверждён вовремя');
}

/** Личный ключ живёт дольше сессии и не требует браузера: если он есть — работаем им. */
let key: string | null = loadKey(domain);
let session: Stored | null = key ? null : readSession() ?? (await deviceLogin());
const authorization = () => `Bearer ${key ?? session!.session}`;

const stdio = new StdioServerTransport();
let http: StreamableHTTPClientTransport;
let initRequest: JSONRPCMessage | undefined;
let initializedNote: JSONRPCMessage | undefined;
let reinit: { resolve: () => void } | undefined;
// Пока не пришёл ответ на initialize, id сессии неизвестен — остальные сообщения ждут.
let initDone: Promise<void> = Promise.resolve();
let initResolve: (() => void) | undefined;

async function openHttp(): Promise<void> {
  if (!key) {
    key = loadKey(domain);                 // ключ мог появиться после `sandbox-mcp login`
    if (!key && !readSession()) session = await deviceLogin();
  }
  http = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: authorization() } } });
  http.onmessage = (m) => {
    if ('id' in m && m.id === REINIT_ID) {
      reinit?.resolve();
      return;
    }
    if (initResolve && 'id' in m && initRequest && 'id' in initRequest && m.id === initRequest.id) {
      initResolve();
      initResolve = undefined;
    }
    void stdio.send(m);
  };
  http.onerror = (e) => log(`http: ${e.message}`);
  await http.start();
}

// После деплоя контейнер поднимается раньше, чем Traefik добавит маршрут, —
// поэтому несколько попыток с паузой.
async function reconnect(): Promise<void> {
  log('сессия потеряна (тул передеплоен?) — переподключаюсь');
  for (let attempt = 1; ; attempt++) {
    await http.close().catch(() => undefined);
    await openHttp();
    try {
      const done = new Promise<void>((resolve) => (reinit = { resolve }));
      await http.send({ ...(initRequest as object), id: REINIT_ID } as JSONRPCMessage);
      await done;
      if (initializedNote) await http.send(initializedNote);
      log(`переподключился (попытка ${attempt})`);
      return;
    } catch (e) {
      if (attempt >= 30) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// 404/400 — сессии больше нет; 502/503/504 — тул ещё поднимается за Traefik.
const isSessionLost = (e: unknown) => {
  const code = (e as { code?: number }).code;
  return [400, 404, 502, 503, 504].includes(code ?? 0) || /session|Bad Gateway|ECONNREFUSED/i.test(String((e as Error).message));
};

// Сообщения хоста пересылаются строго по очереди.
let queue: Promise<void> = Promise.resolve();
stdio.onmessage = (m) => {
  queue = queue.then(() => forward(m));
};

async function forward(m: JSONRPCMessage): Promise<void> {
  const isInit = 'method' in m && m.method === 'initialize';
  const isInitialized = 'method' in m && m.method === 'notifications/initialized';
  if (isInit) {
    initRequest = m;
    initDone = new Promise<void>((resolve) => (initResolve = resolve));
  } else {
    await initDone;
  }
  if (isInitialized) initializedNote = m;
  try {
    await http.send(m);
  } catch (e) {
    if (initRequest && initializedNote && isSessionLost(e)) {
      try {
        await reconnect();
        if (!isInitialized) await http.send(m);
        return;
      } catch (e2) {
        e = e2;
      }
    }
    if (key && (e as { code?: number }).code === 401) {
      log(`ключ MCP не принят (отозван или истёк) — обновите подключение: bin/sandbox-mcp login ${domain}${process.env[KEY_ENV] ? ` (сейчас ключ берётся из ${KEY_ENV})` : ''}`);
    }
    log(`ошибка: ${(e as Error).message}`);
    if ('id' in m && 'method' in m) {
      await stdio.send({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: `тул недоступен: ${(e as Error).message}` } });
    }
  }
}

const shutdown = () => void http.close().finally(() => process.exit(0));
stdio.onclose = shutdown;
process.stdin.on('end', shutdown);

await openHttp();
await stdio.start();
log(`готов, вход: ${key ? 'личный ключ MCP' : session!.actor}`);
