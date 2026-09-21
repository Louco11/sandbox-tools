/**
 * Тестовый MCP-сервер — повторяет инструменты настоящего сервера системы (имена, аргументы, форму ответа)
 * на выдуманных данных из FIXTURE_DATA_FILE. Нужен только для проверки коннектора.
 * TODO агенту: те же инструменты и ответы, что у сервера вашей системы.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const FILE = process.env.FIXTURE_DATA_FILE ?? '/tmp/fixture.json';
type Item = { id: number; name: string; status: string };
const load = (): Item[] => {
  if (!existsSync(FILE)) {
    writeFileSync(FILE, JSON.stringify([
      { id: 1, name: 'Первая позиция', status: 'active' },
      { id: 2, name: 'Вторая позиция', status: 'active' },
      { id: 3, name: 'Третья позиция', status: 'archived' },
    ]));
  }
  return JSON.parse(readFileSync(FILE, 'utf8')) as Item[];
};
const ok = (v: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }], structuredContent: v });
const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

const server = new McpServer({ name: '__NAME__-fixture', version: '1.0.0' });
server.registerTool('list_items', { description: 'Все позиции', annotations: { readOnlyHint: true } }, async () => ok({ items: load() }));
server.registerTool('get_item', { description: 'Позиция по id', inputSchema: { id: z.number().int() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const i = load().find((x) => x.id === id);
    return i ? ok(i) : fail(`позиции #${id} нет`);
  });
server.registerTool('update_item', { description: 'Сменить статус позиции', inputSchema: { id: z.number().int(), status: z.enum(['active', 'archived']) } },
  async ({ id, status }) => {
    const all = load();
    const i = all.find((x) => x.id === id);
    if (!i) return fail(`позиции #${id} нет`);
    i.status = status;
    writeFileSync(FILE, JSON.stringify(all));
    return ok({ id, status });
  });

await server.connect(new StdioServerTransport());
