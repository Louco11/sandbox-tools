/**
 * Конфиги MCP для агентов из одного списка: платформа (mcp-sandbox) + по серверу на каждый тул в tools/.
 *   node infra/agents/sync.ts        (make agents; scaffold_tool вызывает сам)
 *
 * Все агенты запускают один и тот же bin/sandbox-mcp — отличается только формат файла:
 *   .mcp.json          Claude Code        (запускается из корня репозитория)
 *   .cursor/mcp.json   Cursor, cursor-agent (${workspaceFolder})
 *   opencode.json      OpenCode           (корень ищется через git: opencode можно запустить из подпапки)
 * Правила для всех агентов — AGENTS.md.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');

interface Server {
  name: string;
  args: string[];
}

export function servers(): Server[] {
  const tools = readdirSync(join(ROOT, 'tools'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(ROOT, 'tools', d.name, 'tool.yaml')))
    .map((d) => d.name)
    .sort();
  return [{ name: 'sandbox', args: ['platform'] }, ...tools.map((t) => ({ name: `sandbox-${t}`, args: ['tool', t] }))];
}

const opencodeCommand = (args: string[]) => ['sh', '-c', `exec "$(git rev-parse --show-toplevel)/bin/sandbox-mcp" ${args.join(' ')}`];

export function render(list: Server[]): Record<string, unknown> {
  return {
    '.mcp.json': {
      mcpServers: Object.fromEntries(list.map((s) => [s.name, { type: 'stdio', command: './bin/sandbox-mcp', args: s.args }])),
    },
    '.cursor/mcp.json': {
      mcpServers: Object.fromEntries(list.map((s) => [s.name, { command: '${workspaceFolder}/bin/sandbox-mcp', args: s.args }])),
    },
    'opencode.json': {
      $schema: 'https://opencode.ai/config.json',
      mcp: Object.fromEntries(list.map((s) => [s.name, { type: 'local', command: opencodeCommand(s.args), enabled: true }])),
    },
  };
}

export function sync(): string[] {
  const changed: string[] = [];
  for (const [file, content] of Object.entries(render(servers()))) {
    const path = join(ROOT, file);
    const text = `${JSON.stringify(content, null, 2)}\n`;
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    changed.push(file);
  }
  return changed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = sync();
  const list = servers().map((s) => s.name).join(', ');
  console.log(changed.length ? `обновлено: ${changed.join(', ')}\nсерверы: ${list}` : `конфиги агентов актуальны (${list})`);
}
