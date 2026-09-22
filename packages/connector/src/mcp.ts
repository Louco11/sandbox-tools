/**
 * Универсальный MCP-коннектор: MCP-сервер системы (CRM, трекер, 1С…) подключается файлом соответствий, без кода.
 *   await startMcpConnector('connectors/<имя>/config.yaml')
 *
 * Читающий инструмент MCP → набор данных; инструмент с побочным эффектом → право записи. Проброс «всего сервера» нет:
 * тулы видят только то, что перечислено здесь И одобрено в реестре. Сводку для человека собирает шаблон — у MCP нет
 * шага «покажи, что изменится», поэтому describe только читает (read) и никогда не вызывает пишущий инструмент.
 *
 *   name: crm
 *   server:                          # локальный сервер (stdio) — процесс внутри контейнера коннектора
 *     command: node
 *     args: [connectors/crm/fixture/server.ts]
 *     env: [CRM_DATA_FILE]           # какие переменные окружения передать серверу; остальное он не видит
 *   # server: { url: https://crm.internal/mcp, headers_env: { Authorization: CRM_MCP_AUTH } }   # удалённый
 *   # server: { url_env: HOLST_MCP_URL, command: … }  # url_env задан — HTTP; иначе stdio-фикстура
 *   datasets:
 *     deals: { tool: list_deals, rows: deals }             # rows — путь к массиву в structuredContent
 *     # map: { id: workspaceId, name: name }               # поле реестра ← поле ответа MCP (camelCase → snake)
 *   writes:
 *     crm.deal:set_stage:
 *       tool: update_deal
 *       args: { id: deal_id, stage: stage }                # аргумент инструмента ← параметр записи
 *       read: { tool: get_deal, args: { id: deal_id }, as: deal }   # текущее состояние — только для сводки
 *       summary: "Сделка «{deal.title}»: стадия {deal.stage} → {stage}"
 */
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parse } from 'yaml';
import { ConnectorError, applyQuery, startConnector, type Params, type Row, type WriteHandler } from './index.ts';

interface ToolCall { tool: string; args?: Record<string, string>; fixed?: Record<string, unknown> }
interface McpConfig {
  name: string;
  server: {
    command?: string;
    args?: string[];
    env?: string[];
    url?: string;
    /** Если переменная задана — Streamable HTTP вместо stdio (удобно: фикстура в тесте, живой URL в проде). */
    url_env?: string;
    headers_env?: Record<string, string>;
  };
  datasets: Record<string, ToolCall & { rows: string; map?: Record<string, string> }>;
  writes: Record<string, ToolCall & { summary: string; read?: ToolCall & { as: string } }>;
}

const path = (v: unknown, p: string): unknown => p.split('.').filter(Boolean).reduce<unknown>((o, k) => (o as Record<string, unknown> | null)?.[k], v);
const render = (tpl: string, ctx: Record<string, unknown>) => tpl.replace(/\{([\w.]+)\}/g, (_m, p: string) => String(path(ctx, p) ?? '?'));
const argsOf = (c: ToolCall, params: Params) => ({
  ...c.fixed,
  ...Object.fromEntries(Object.entries(c.args ?? {}).filter(([, from]) => params[from] !== undefined).map(([arg, from]) => [arg, params[from]])),
});

/** Holst и другие серверы кладут JSON во второй text-блок; structuredContent — предпочтительнее. */
function payloadOf(r: { structuredContent?: unknown; content?: { type: string; text?: string }[] }): unknown {
  if (r.structuredContent) return r.structuredContent;
  const texts = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '');
  for (const t of [...texts].reverse()) {
    try {
      return JSON.parse(t);
    } catch {
      /* следующий фрагмент */
    }
  }
  return { text: texts[0] ?? '' };
}

function mapRows(rows: unknown[], map?: Record<string, string>): Row[] {
  if (!map) return rows as Row[];
  return rows.map((row) => {
    const src = row as Record<string, unknown>;
    return Object.fromEntries(Object.entries(map).map(([to, from]) => [to, src[from] ?? null]));
  });
}

export async function startMcpConnector(configPath: string): Promise<void> {
  const cfg = parse(readFileSync(configPath, 'utf8')) as McpConfig;
  const client = new Client({ name: `connector-${cfg.name}`, version: '0.1.0' });
  const s = cfg.server;
  const url = (s.url_env ? process.env[s.url_env] : undefined) || s.url;
  const transport = url
    ? new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: Object.fromEntries(Object.entries(s.headers_env ?? {}).map(([h, e]) => [h, process.env[e] ?? ''])) },
    })
    : new StdioClientTransport({
      command: s.command!,
      args: s.args ?? [],
      // Серверу — только перечисленные переменные: учётки коннектора и токен гейтвея он не видит.
      env: Object.fromEntries([...(s.env ?? []), 'PATH'].filter((e) => process.env[e]).map((e) => [e, process.env[e]!])),
    });
  await client.connect(transport);

  const available = new Set((await client.listTools()).tools.map((t) => t.name));
  const used = [...Object.values(cfg.datasets), ...Object.values(cfg.writes).flatMap((w) => [w, ...(w.read ? [w.read] : [])])].map((c) => c.tool);
  const missing = used.filter((t) => !available.has(t));
  if (missing.length) throw new Error(`у MCP-сервера нет инструментов: ${[...new Set(missing)].join(', ')}`);

  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
    const r = await client.callTool({ name: tool, arguments: args });
    const texts = ((r.content as { type: string; text?: string }[] | undefined) ?? [])
      .filter((c) => c.type === 'text').map((c) => c.text ?? '');
    // Ошибка инструмента — ошибка для человека: MCP не различает «нет объекта» и «неверные данные».
    if (r.isError) throw new ConnectorError(400, texts[0] || `${tool}: ошибка`);
    return payloadOf(r as { structuredContent?: unknown; content?: { type: string; text?: string }[] });
  };

  startConnector({
    name: cfg.name,
    token: process.env.CONNECTOR_TOKEN ?? '',
    datasets: Object.fromEntries(Object.entries(cfg.datasets).map(([ds, d]) => [ds, async (q) => {
      const rows = path(await call(d.tool, { ...d.fixed }), d.rows);
      if (!Array.isArray(rows)) throw new Error(`${d.tool}: по пути «${d.rows}» не массив`);
      return applyQuery(mapRows(rows, d.map), q);
    }])),
    writes: Object.fromEntries(Object.entries(cfg.writes).map(([id, w]): [string, WriteHandler] => [id, {
      describe: async (params) => {
        const ctx: Record<string, unknown> = { ...params };
        if (w.read) ctx[w.read.as] = await call(w.read.tool, argsOf(w.read, params));
        return render(w.summary, ctx);
      },
      apply: async (params) => {
        const r = await call(w.tool, argsOf(w, params));
        return (r && typeof r === 'object' && !Array.isArray(r) ? r : { result: r }) as Row;
      },
    }])),
  });
}
