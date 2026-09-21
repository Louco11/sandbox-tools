/**
 * Тестовый MCP-сервер Holst — те же имена инструментов и форма ответа ({ ok, data }), что у holst-mcp.
 * Данные — FIXTURE_DATA_FILE. Настоящий Holst проверка не трогает.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const FILE = process.env.FIXTURE_DATA_FILE ?? '/tmp/holst-fixture.json';

interface Workspace { id: string; name: string; role: string }
interface Board { id: string; name: string; workspace_id: string }
interface Run { board_id: string; description: string; code: string }
interface Store { workspaces: Workspace[]; boards: Board[]; runs: Run[] }

const seed = (): Store => ({
  workspaces: [
    { id: 'ws-personal', name: 'Личное', role: 'owner' },
    { id: 'ws-team', name: 'Команда', role: 'member' },
  ],
  boards: [
    { id: 'b3e7d953-c1d5-4e6b-874d-07d0b9d56fc1', name: 'Активная доска', workspace_id: 'ws-personal' },
  ],
  runs: [],
});

const load = (): Store => {
  if (!existsSync(FILE)) writeFileSync(FILE, JSON.stringify(seed()));
  return JSON.parse(readFileSync(FILE, 'utf8')) as Store;
};
const save = (s: Store) => writeFileSync(FILE, JSON.stringify(s));

/** Как живой Holst: человекочитаемый text + JSON во втором блоке; плюс structuredContent для удобства. */
const reply = (message: string, body: Record<string, unknown>) => ({
  content: [
    { type: 'text' as const, text: message },
    { type: 'text' as const, text: JSON.stringify(body) },
  ],
  structuredContent: body,
});
const fail = (message: string, code = 'ERROR') => ({
  isError: true as const,
  content: [
    { type: 'text' as const, text: message },
    { type: 'text' as const, text: JSON.stringify({ ok: false, error: { code, message } }) },
  ],
});

const server = new McpServer({ name: 'holst-fixture', version: '4.0.0' });

server.registerTool(
  'list_workspaces',
  { description: 'List workspaces', annotations: { readOnlyHint: true } },
  async () => reply('Workspaces listed.', { ok: true, data: { workspaces: load().workspaces } }),
);

server.registerTool(
  'resolve_board',
  {
    description: 'Resolve board',
    inputSchema: { url: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async () => {
    const board = load().boards[0];
    if (!board) return fail('NO_ACTIVE_BOARD', 'NO_ACTIVE_BOARD');
    return reply(`Resolved Holst board ${board.id}.`, {
      ok: true,
      data: { boardId: board.id, source: 'active_tab' },
    });
  },
);

server.registerTool(
  'create_board',
  {
    description: 'Create board',
    inputSchema: {
      name: z.string().min(1),
      workspaceId: z.string().optional(),
    },
  },
  async ({ name, workspaceId }) => {
    const s = load();
    const ws = workspaceId
      ? s.workspaces.find((w) => w.id === workspaceId)
      : s.workspaces[0];
    if (!ws) return fail(`workspace ${workspaceId} unavailable`);
    const board: Board = { id: randomUUID(), name, workspace_id: ws.id };
    s.boards.push(board);
    save(s);
    return reply(`Created board ${board.id}.`, {
      ok: true,
      data: { boardId: board.id, resultLink: `holst://board/${board.id}` },
    });
  },
);

server.registerTool(
  'use_holst',
  {
    description: 'Run code on board',
    inputSchema: {
      boardId: z.string().uuid(),
      code: z.string(),
      description: z.string(),
    },
    annotations: { destructiveHint: true },
  },
  async ({ boardId, code, description }) => {
    const s = load();
    const board = s.boards.find((b) => b.id === boardId);
    if (!board) return fail(`board ${boardId} not found`);
    s.runs.push({ board_id: boardId, description, code });
    save(s);
    return reply(`Ran on ${boardId}.`, {
      ok: true,
      data: { boardId, description, resultLink: `holst://board/${boardId}` },
    });
  },
);

await server.connect(new StdioServerTransport());
