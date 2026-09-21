import { App } from '@modelcontextprotocol/ext-apps/app-with-deps';

/**
 * Один и тот же UI работает в двух фасадах:
 *   web     — страница тула, действия через /api/actions/*
 *   mcp-app — iframe в хосте агента, действия через MCP tools/call хоста
 * Код тула видит только call(): как именно идёт вызов, решает каркас.
 */

interface Boot {
  mode: 'web' | 'mcp-app';
  tool: string;
  title: string;
  actor: string | null;
}

export const boot: Boot = (globalThis as { __SANDBOX__?: Boot }).__SANDBOX__ ?? {
  mode: 'web',
  tool: 'unknown',
  title: 'Тул',
  actor: null,
};

export const isApp = boot.mode === 'mcp-app';

let app: App | null = null;

export async function connect(): Promise<void> {
  if (!isApp) return;
  app = new App({ name: boot.tool, version: '0.1.0' });
  app.onhostcontextchanged = (ctx) => applyTheme(ctx.theme);
  await app.connect();
  applyTheme(app.getHostContext()?.theme);
}

function applyTheme(theme: string | undefined) {
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
}

export class ActionError extends Error {}

export async function call<T = unknown>(action: string, input: Record<string, unknown> = {}): Promise<T> {
  if (app) {
    const res = await app.callServerTool({ name: action, arguments: input });
    const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
    if (res.isError) throw new ActionError(text || 'ошибка действия');
    return JSON.parse(text) as T;
  }
  const res = await fetch(`/api/actions/${encodeURIComponent(action)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });
  const body = (await res.json().catch(() => ({}))) as { result?: T; message?: string };
  if (!res.ok) throw new ActionError(body.message ?? `ошибка ${res.status}`);
  return body.result as T;
}

/** Сообщить агенту о результате в чате (только в режиме MCP App). */
export async function tellAgent(text: string): Promise<void> {
  await app?.sendMessage({ role: 'user', content: [{ type: 'text', text }] }).catch(() => undefined);
}
