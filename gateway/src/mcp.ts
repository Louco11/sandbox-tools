import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registry } from './config.ts';
import type { CallContext } from './context.ts';
import { queryInputShape, runQuery } from './query.ts';
import { prepareWrite } from './writes.ts';

const json = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const failure = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: (e as Error).message }],
});

/**
 * MCP-фасад гейтвея для run-time агента внутри тула.
 * Агент работает с токеном тула и его скоупом; собственных прав у него нет.
 * Подтверждения записи здесь нет намеренно: подтверждает только человек.
 */
export function createMcpServer(ctx: CallContext): McpServer {
  const server = new McpServer({ name: 'sandbox-gateway', version: '0.1.0' });

  server.registerTool(
    'list_sources',
    {
      description: 'Источники и права на запись из реестра, с полями, чувствительностью и признаком доступности этому тулу',
    },
    async () =>
      json({
        tool: ctx.tool,
        sources: Object.entries(registry.sources).map(([id, s]) => ({
          id,
          title: s.title,
          in_scope: ctx.manifest.sources.includes(id),
          datasets: Object.fromEntries(
            Object.entries(s.datasets).map(([name, d]) => [name, { description: d.description, fields: d.fields }]),
          ),
        })),
        writes: Object.entries(registry.writes).map(([id, w]) => ({
          id,
          title: w.title,
          in_scope: ctx.manifest.writes.includes(id),
          params: w.params,
        })),
      }),
  );

  server.registerTool(
    'query_source',
    {
      description: 'Прочитать набор данных источника. Доступны только источники из tool.yaml тула',
      inputSchema: { source: z.string().describe('id источника, например tasks-readonly'), ...queryInputShape },
    },
    async ({ source, ...query }) => {
      try {
        return json(await runQuery(ctx, source, query));
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'prepare_write',
    {
      description:
        'Подготовить запись в боевую систему. Данные не меняются: человек подтверждает запись в интерфейсе тула по confirmation_id',
      inputSchema: {
        write: z.string().describe('id права на запись, например tasks.task:create'),
        params: z.record(z.string(), z.union([z.string(), z.number()])),
      },
    },
    async ({ write, params }) => {
      try {
        return json(await prepareWrite(ctx, write, params));
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
