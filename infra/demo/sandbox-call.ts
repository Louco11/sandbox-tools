/**
 * Вызов инструмента mcp-sandbox из терминала — так же, как это делает агент по MCP.
 *   node infra/demo/sandbox-call.ts list_sources
 *   node infra/demo/sandbox-call.ts validate_manifest '{"name":"manager-board"}'
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [tool, args = '{}'] = process.argv.slice(2);
const client = new Client({ name: 'sandbox-cli', version: '1.0.0' });
await client.connect(
  // Окружение передаём явно: MCP-клиент по умолчанию отдаёт серверу урезанный набор переменных,
  // а ключ человека (SANDBOX_MCP_KEY) в терминале обычно задают именно переменной.
  new StdioClientTransport({
    command: 'node',
    args: ['--disable-warning=ExperimentalWarning', 'mcp-sandbox/src/main.ts'],
    env: process.env as Record<string, string>,
  }),
);
if (!tool) {
  for (const t of (await client.listTools()).tools) console.log(`${t.name.padEnd(18)} ${t.description}`);
} else {
  const res = await client.callTool({ name: tool, arguments: JSON.parse(args) }, undefined, { timeout: 15 * 60_000 });
  for (const c of res.content as { text?: string }[]) console.log(c.text);
  if (res.isError) process.exitCode = 1;
}
await client.close();
