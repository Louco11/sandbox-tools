import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { parse } from 'yaml';
import { z } from 'zod';
import { decodeJwt } from 'jose';
import { manifestSchema, type Manifest } from '@sandbox/manifest';
import { GatewayClient, GatewayError, type Caller } from './gateway.ts';
import type { ActionContext, ToolDef } from './tool.ts';

const UI_EXTENSION = 'io.modelcontextprotocol/ui';
const MCP_APP_MIME = 'text/html;profile=mcp-app';
const ACTOR = /^[a-z][a-z0-9._-]{1,63}$/;
/** Личность человека от ForwardAuth: ставит только Traefik через сервис identity (шаг Б1). */
const IDENTITY_HEADER = 'x-sandbox-identity';

/** Встроенное действие: подтверждение записи кнопкой в интерфейсе тула. Только человек, модели не видно. */
export const COMMIT_WRITE = 'commit_write';
/** Встроенное действие агента: применить подготовленную запись после согласия человека в чате (approval — его ответ). */
export const COMMIT_APPROVED = 'commit_approved';

/** Встроенные действия жизненного цикла: срок жизни тула, продление и удаление владельцем. */
export const LIFECYCLE = 'lifecycle';
export const LIFECYCLE_EXTEND = 'lifecycle_extend';
export const LIFECYCLE_DELETE = 'lifecycle_delete';
const BUILTINS = [COMMIT_WRITE, COMMIT_APPROVED, LIFECYCLE, LIFECYCLE_EXTEND, LIFECYCLE_DELETE];

class ToolError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function loadManifest(): Manifest {
  return manifestSchema.parse(parse(readFileSync('tool.yaml', 'utf8')));
}

function loadBundle(): string | null {
  return existsSync('dist/app.js') ? readFileSync('dist/app.js', 'utf8') : null;
}

const scriptSafe = (s: string) => s.replace(/<\/script/gi, '<\\/script');
const jsonSafe = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

function toMcpResult(fn: () => Promise<unknown>) {
  return fn().then(
    (result) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: (result && typeof result === 'object' && !Array.isArray(result) ? result : { result }) as Record<string, unknown>,
    }),
    (e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }),
  );
}

/**
 * Запускает тул: web-витрина, MCP-сервер с MCP App и доступ к данным через гейтвей.
 * Авторизация, токены, аудит-контекст и подтверждение записи — здесь, а не в коде тула.
 */
export function startTool(def: ToolDef): void {
  const manifest = loadManifest();
  const gateway = GatewayClient.fromEnv();
  const bundle = loadBundle();
  const uiUri = `ui://${manifest.name}/app.html`;
  const hasWeb = manifest.ui.mode.includes('web');
  const hasApp = manifest.ui.mode.includes('mcp-app');

  for (const name of BUILTINS) {
    if (name in def.actions) throw new Error(`имя действия ${name} зарезервировано каркасом`);
  }

  const context = (caller: Caller): ActionContext => ({
    ...caller,
    query: (source, dataset, q) => gateway.query(caller, source, dataset, q),
    prepareWrite: (write, params) => gateway.prepareWrite(caller, write, params),
  });

  async function runAction(name: string, rawInput: unknown, caller: Caller): Promise<unknown> {
    if (name === COMMIT_WRITE) {
      if (caller.agent) throw new ToolError(403, 'подтвердить запись может только человек');
      const id = (rawInput as { confirmation_id?: unknown } | null)?.confirmation_id;
      if (typeof id !== 'string') throw new ToolError(400, 'нужен confirmation_id');
      return gateway.commitWrite(caller, id);
    }
    if (name === COMMIT_APPROVED) {
      // Проверяет гейтвей: агенту — только подготовленное агентом и только с согласием; в аудите — агент в цепочке.
      const { confirmation_id: id, approval } = (rawInput ?? {}) as { confirmation_id?: unknown; approval?: unknown };
      if (typeof id !== 'string') throw new ToolError(400, 'нужен confirmation_id');
      if (typeof approval !== 'string') throw new ToolError(400, 'нужно approval — согласие человека из чата дословно');
      return gateway.commitWrite(caller, id, approval);
    }
    if (name === LIFECYCLE) return gateway.lifecycle(caller);
    if (name === LIFECYCLE_EXTEND || name === LIFECYCLE_DELETE) {
      if (caller.agent) throw new ToolError(403, 'продлить или удалить тул может только его владелец, не агент');
      if (name === LIFECYCLE_DELETE) return gateway.revokeLifecycle(caller);
      const days = (rawInput as { days?: unknown } | null)?.days;
      return gateway.extendLifecycle(caller, typeof days === 'number' ? days : undefined);
    }
    const a = def.actions[name];
    if (!a) throw new ToolError(404, `у тула нет действия ${name}`);
    const parsed = z.object(a.input).safeParse(rawInput ?? {});
    if (!parsed.success) throw new ToolError(400, parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    return a.handler(parsed.data, context(caller));
  }

  function page(mode: 'web' | 'mcp-app', actor: string | null): string {
    const boot = { mode, tool: gateway.tool, title: def.title, actor };
    const body = bundle
      ? `<script type="module">${scriptSafe(bundle)}</script>`
      : '<p style="font-family:sans-serif;padding:24px">UI не собран: нет dist/app.js</p>';
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${def.title}</title></head>
<body><div id="app"></div><script>window.__SANDBOX__=${jsonSafe(boot)}</script>${body}</body></html>`;
  }

  // MCP: инструменты для агента + MCP App для человека в хосте агента ------------------

  function buildMcp(caller: Caller): McpServer {
    const server = new McpServer({ name: manifest.name, version: '0.1.0' }, { capabilities: { tools: { listChanged: true } } });

    for (const [name, a] of Object.entries(def.actions)) {
      server.registerTool(
        name,
        { description: a.description, inputSchema: a.input, _meta: { ui: { visibility: ['model', 'app'] } } },
        async (input: unknown) => toMcpResult(() => runAction(name, input, caller)),
      );
    }

    // Запись агентом: действие только готовит и возвращает summary. Агент показывает его человеку в чате и
    // применяет этим инструментом лишь после согласия, передавая ответ человека дословно. Вызов идёт от агента:
    // гейтвей пускает только к подготовленному агентом, а аудит честно пишет «агент в цепочке» и согласие.
    server.registerTool(
      COMMIT_APPROVED,
      {
        description:
          'Применить подготовленную запись после ЯВНОГО согласия человека в чате. Порядок: вызвать действие → показать ' +
          'человеку summary дословно → спросить, применить ли → только после «да» вызвать этот инструмент, передав в approval ' +
          'ответ человека дословно. Без согласия не вызывать; согласие на одну запись не распространяется на другие.',
        inputSchema: {
          confirmation_id: z.string().describe('из ответа действия'),
          approval: z.string().min(2).describe('ответ человека в чате дословно, например «да, списывай»'),
        },
        _meta: { ui: { visibility: ['model'] } },
      },
      async (input: unknown) => toMcpResult(() => runAction(COMMIT_APPROVED, input, caller)),
    );

    if (hasApp) {
      server.registerTool(
        'open_ui',
        {
          title: def.title,
          description: `Показать пользователю интерфейс «${def.title}». ${def.description}`,
          _meta: { ui: { resourceUri: uiUri } },
        },
        async () => ({ content: [{ type: 'text' as const, text: `Интерфейс «${def.title}» открыт пользователю.` }] }),
      );
      server.registerResource('app', uiUri, { mimeType: MCP_APP_MIME, description: def.description }, async () => ({
        contents: [{ uri: uiUri, mimeType: MCP_APP_MIME, text: page('mcp-app', caller.actor) }],
      }));

      // Подтверждение записи, срок жизни и решения владельца — только из UI: агент не продлевает и не удаляет тул.
      server.server.oninitialized = () => {
        const caps = server.server.getClientCapabilities() as { extensions?: Record<string, unknown> } | undefined;
        const client = server.server.getClientVersion();
        console.log(JSON.stringify({ type: 'mcp_session', client: client?.name, version: client?.version, actor: caller.actor, mcp_apps: Boolean(caps?.extensions?.[UI_EXTENSION]) }));
        if (!caps?.extensions?.[UI_EXTENSION]) return;
        // Кнопка «Подтвердить» в интерфейсе тула — только UI (visibility: app) и только у хоста с MCP Apps:
        // иначе хост показал бы инструмент модели, и агент подтвердил бы от имени человека.
        server.registerTool(
          COMMIT_WRITE,
          { description: 'Подтверждение записи человеком из интерфейса тула', inputSchema: { confirmation_id: z.string() }, _meta: { ui: { visibility: ['app'] } } },
          async (input: unknown) => toMcpResult(() => runAction(COMMIT_WRITE, input, { actor: caller.actor, agent: null, identity: caller.identity })),
        );
        server.registerTool(
          LIFECYCLE,
          { description: 'Срок жизни тула для баннера в интерфейсе', _meta: { ui: { visibility: ['app'] } } },
          async () => toMcpResult(() => runAction(LIFECYCLE, {}, { actor: caller.actor, agent: null, identity: caller.identity })),
        );
        server.registerTool(
          LIFECYCLE_EXTEND,
          { description: 'Продление тула владельцем из интерфейса', inputSchema: { days: z.number().int().positive().optional() }, _meta: { ui: { visibility: ['app'] } } },
          async (input: unknown) => toMcpResult(() => runAction(LIFECYCLE_EXTEND, input, { actor: caller.actor, agent: null, identity: caller.identity })),
        );
        server.registerTool(
          LIFECYCLE_DELETE,
          { description: 'Удаление тула владельцем из интерфейса', _meta: { ui: { visibility: ['app'] } } },
          async () => toMcpResult(() => runAction(LIFECYCLE_DELETE, {}, { actor: caller.actor, agent: null, identity: caller.identity })),
        );
      };
    }
    return server;
  }

  const sessions = new Map<string, StreamableHTTPServerTransport>();

  // HTTP ------------------------------------------------------------------------------

  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, tool: gateway.tool });
  });

  // Что это за тул — для каталога на главной: название, описание, действия, источники и права записи из манифеста.
  // Только описание, данных здесь нет.
  app.get('/_meta', (_req, res) => {
    res.json({
      name: manifest.name,
      instance: gateway.tool,
      title: def.title,
      description: def.description,
      owner: manifest.owner,
      ui: manifest.ui.mode,
      sources: manifest.sources,
      writes: manifest.writes,
      actions: Object.entries(def.actions).map(([name, a]) => ({ name, description: a.description })),
    });
  });

  if (hasWeb) {
    // Личность приходит заголовком от Traefik: без входа запрос до тула не доходит (ForwardAuth, шаг Б1).
    // Тул её не проверяет и не хранит — только читает логин для интерфейса и пересылает в гейтвей.
    const webCaller = (req: Request): Caller | null => {
      const identity = req.header(IDENTITY_HEADER);
      const actor = identity ? (decodeJwt(identity).sub as string | undefined) : undefined;
      return identity && actor && ACTOR.test(actor) ? { actor, agent: null, identity } : null;
    };

    app.get('/', (req, res) => {
      const caller = webCaller(req);
      if (!caller) {
        res.status(401).type('html').send(`<!doctype html><meta charset="utf-8"><title>${def.title}</title>
<body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 16px">
<h2 style="margin-bottom:4px">${def.title}</h2><p style="color:#666">Личность не подтверждена. Откройте тул по адресу песочницы — вход спросит IdP компании.</p>`);
        return;
      }
      res.type('html').send(page('web', caller.actor));
    });

    app.post('/api/actions/:name', async (req, res, next) => {
      const caller = webCaller(req);
      if (!caller) {
        res.status(401).json({ error: 'unauthorized', message: 'войдите заново: личность истекла' });
        return;
      }
      try {
        res.json({ result: await runAction(String(req.params.name), req.body?.input, caller) });
      } catch (e) {
        next(e);
      }
    });
  }

  app.post('/mcp', async (req, res, next) => {
    try {
      const sid = req.header('mcp-session-id');
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        if (sid || !isInitializeRequest(req.body)) {
          res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'сессия не найдена, начните с initialize' }, id: null });
          return;
        }
        // Личность человека ставит Traefik после входа агента в IdP (device flow, шаг Б1.2).
        const identity = req.header(IDENTITY_HEADER);
        const actor = identity ? String(decodeJwt(identity).sub ?? '') : '';
        if (!identity || !ACTOR.test(actor)) {
          res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'нет личности: подключайтесь через bin/sandbox-mcp — он проведёт вход в браузере' }, id: null });
          return;
        }
        const clientName = (req.body.params?.clientInfo?.name as string | undefined) ?? 'client';
        const agent = `mcp:${req.header('x-agent') ?? clientName}`;
        const t: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => void sessions.set(id, t),
        });
        t.onclose = () => {
          if (t.sessionId) sessions.delete(t.sessionId);
        };
        await buildMcp({ actor, agent, identity }).connect(t);
        transport = t;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const t = sessions.get(req.header('mcp-session-id') ?? '');
    if (!t) {
      res.status(404).json({ error: 'session_not_found' });
      return;
    }
    await t.handleRequest(req, res);
  };
  app.get('/mcp', sessionRequest);
  app.delete('/mcp', sessionRequest);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ToolError || err instanceof GatewayError) {
      res.status(err.status).json({ error: err instanceof GatewayError ? err.code : 'tool_error', message: err.message });
      return;
    }
    console.error(JSON.stringify({ type: 'error', error: String(err), stack: (err as Error)?.stack }));
    res.status(500).json({ error: 'internal', message: 'внутренняя ошибка тула' });
  });

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(JSON.stringify({ type: 'started', tool: gateway.tool, port, ui: manifest.ui.mode, actions: Object.keys(def.actions) }));
  });
}
