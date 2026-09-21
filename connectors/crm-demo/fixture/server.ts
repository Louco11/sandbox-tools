/**
 * Тестовый MCP-сервер «CRM» — фикстура для connectors/crm-demo: так выглядел бы MCP-сервер настоящей CRM.
 * Данные — JSON-файл CRM_DATA_FILE (создаётся с демо-сделками). Инструмент delete_deal есть у сервера, но в
 * config.yaml коннектора не отображён — тулы его не получат: проброса «всего сервера» нет.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const FILE = process.env.CRM_DATA_FILE ?? '/data/crm.json';
const STAGES = ['lead', 'negotiation', 'won', 'lost'] as const;
interface Deal { id: number; title: string; client: string; amount: number; stage: (typeof STAGES)[number] }

const load = (): Deal[] => {
  if (!existsSync(FILE)) {
    writeFileSync(FILE, JSON.stringify([
      { id: 1, title: 'Торты на корпоратив', client: 'ООО «Ромашка»', amount: 48000, stage: 'negotiation' },
      { id: 2, title: 'Ежемесячные десерты', client: 'Кафе «Уют»', amount: 120000, stage: 'lead' },
      { id: 3, title: 'Свадебный торт', client: 'Мария Иванова', amount: 18000, stage: 'won' },
    ]));
  }
  return JSON.parse(readFileSync(FILE, 'utf8')) as Deal[];
};
const save = (d: Deal[]) => writeFileSync(FILE, JSON.stringify(d));
const ok = (v: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v) }], structuredContent: v });
const fail = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });

const server = new McpServer({ name: 'crm-fixture', version: '1.0.0' });
server.registerTool('list_deals', { description: 'Все сделки', annotations: { readOnlyHint: true } }, async () => ok({ deals: load() }));
server.registerTool('get_deal', { description: 'Сделка по id', inputSchema: { id: z.number().int() }, annotations: { readOnlyHint: true } },
  async ({ id }) => {
    const d = load().find((x) => x.id === id);
    return d ? ok(d as unknown as Record<string, unknown>) : fail(`сделки #${id} нет`);
  });
server.registerTool('update_deal', { description: 'Сменить стадию сделки', inputSchema: { id: z.number().int(), stage: z.enum(STAGES) } },
  async ({ id, stage }) => {
    const all = load();
    const d = all.find((x) => x.id === id);
    if (!d) return fail(`сделки #${id} нет`);
    d.stage = stage;
    save(all);
    return ok({ id, stage });
  });
server.registerTool('delete_deal', { description: 'Удалить сделку', inputSchema: { id: z.number().int() }, annotations: { destructiveHint: true } },
  async ({ id }) => {
    save(load().filter((x) => x.id !== id));
    return ok({ deleted: id });
  });

await server.connect(new StdioServerTransport());
