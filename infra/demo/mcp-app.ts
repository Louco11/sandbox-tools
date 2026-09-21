/**
 * Демо MCP-фасада тула глазами хоста агента.
 *   node infra/demo/mcp-app.ts [инстанс]   по умолчанию manager-board; превью — manager-board--<ветка>
 *
 * Демо пишет в базу знаний одну запись «Итог» от имени anna.smirnova — знания только дописываются.
 *
 * Агент готовит запись (prepare) и получает summary; человек соглашается в чате; агент применяет
 * commit_approved с его ответом. commit_write — только кнопка UI (visibility: app), модели не виден.
 */
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const tool = process.argv[2] ?? 'manager-board';          // инстанс: прод или превью <тул>--<ветка>
const toolName = tool.split('--')[0];                    // имя тула из манифеста — в uri его UI
const url = new URL(`http://${tool}.tools.localhost:18000/mcp`);
// Тул открыт только владельцу (шаг Б4): демо открывает его своему человеку и в конце возвращает как было.
const portalToken = execFileSync('sh', ['-c', "sed -n 's/^GATEWAY_PORTAL_TOKEN=//p' .env | tail -1"], { encoding: 'utf8' }).trim();
const human = execFileSync('sh', ['-c', "sed -n 's/^GITEA_HUMAN_USER=//p' .env | tail -1"], { encoding: 'utf8' }).trim() || 'ivan.petrov';
const adminIdentity = execFileSync('docker', ['compose', 'exec', '-T', 'identity', 'node', 'infra/identity/src/mint.ts', human, 'portal', '5m', 'web', 'sandbox-admins'], { encoding: 'utf8' }).trim().split('\n').pop()!;
const setAccess = async (people: string[]) => {
  await fetch(`http://localhost:18080/v1/admin/tools/${toolName}/access`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${portalToken}`, 'X-Sandbox-Identity': adminIdentity },
    body: JSON.stringify({ people }),
  });
};
await setAccess(['anna.smirnova']);

// Вход агента: сессия, какую мост получает через device flow. Здесь подписываем её ключом identity внутри стенда.
const session = execFileSync('docker', ['compose', 'exec', '-T', 'identity', 'node', 'infra/identity/src/mint.ts', 'anna.smirnova', 'sandbox-session', '10m', 'mcp'], { encoding: 'utf8' }).trim().split('\n').pop()!;
const UI_EXT = 'io.modelcontextprotocol/ui';

async function connect(name: string, withUi: boolean): Promise<Client> {
  const capabilities = withUi ? { extensions: { [UI_EXT]: { mimeTypes: ['text/html;profile=mcp-app'] } } } : {};
  const client = new Client({ name, version: '1.0.0' }, { capabilities: capabilities as object });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${session}` } } }));
  await new Promise((r) => setTimeout(r, 300));
  return client;
}

const text = (r: { content?: unknown }) => ((r.content as { text?: string }[] | undefined)?.[0]?.text ?? '');
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

step('1. Хост без MCP Apps: инструменты модели (commit_approved есть, commit_write — нет)');
const plain = await connect('plain-host', false);
const plainTools = (await plain.listTools()).tools.map((t) => t.name);
for (const n of plainTools) console.log(`  ${n}`);
if (plainTools.includes('commit_write')) throw new Error('commit_write не должен быть виден модели');
if (!plainTools.includes('commit_approved')) throw new Error('нет commit_approved');

step('2. Хост с MCP Apps: инструменты и видимость');
const host = await connect('apps-host', true);
for (const t of (await host.listTools()).tools) {
  const ui = (t._meta as { ui?: { visibility?: string[]; resourceUri?: string } } | undefined)?.ui;
  console.log(`  ${t.name.padEnd(18)} видимость: ${(ui?.visibility ?? ['model', 'app']).join(', ')}${ui?.resourceUri ? `  → ${ui.resourceUri}` : ''}`);
}

step('3. UI-ресурс, который хост отрисует в iframe');
const res = await host.readResource({ uri: `ui://${toolName}/app.html` });
const html = res.contents[0] as { mimeType?: string; text?: string };
console.log(`  mimeType: ${html.mimeType}, размер: ${Math.round((html.text?.length ?? 0) / 1024)} КБ, режим: ${html.text?.match(/"mode":"([^"]+)"/)?.[1]}`);

step('4. Агент читает доску: board — сводка и закрытые задачи без итога');
const board = JSON.parse(text(await host.callTool({ name: 'board', arguments: {} })));
console.log(`  открыто: ${board.summary.open}, просрочено: ${board.summary.overdue}, срочных: ${board.summary.urgent}`);
const done = board.columns.done as { id: number; title: string; notes: number }[];
const target = done.find((t) => t.notes === 0) ?? done[0];
if (!target) throw new Error('в колонке «Сделано» нет задач — демо нечего подытожить');
const card = JSON.parse(text(await host.callTool({ name: 'task', arguments: { task_id: target.id } })));
console.log(`  задача #${target.id} «${target.title}», записей в знаниях: ${card.notes.length}`);

step('5. Агент готовит итог: add_note kind=summary (данные не меняются)');
const prepared = JSON.parse(
  text(
    await host.callTool({
      name: 'add_note',
      arguments: {
        kind: 'summary',
        task_id: target.id,
        title: `Итог (демо): ${target.title}`,
        body: `Задача закрыта в срок. ${card.task.description || 'Описание не заполнено'}. Черновик итога подготовлен агентом, проверен человеком.`,
        tags: 'итог,демо',
      },
    }),
  ),
);
console.log(`  ${prepared.summary}`);
if (!prepared.confirmation_id) throw new Error('ожидался confirmation_id после prepare');
console.log(`  агенту: ${prepared.next}`);

step('6а. Агент пытается применить без согласия → отказ гейтвея');
const noApproval = await host.callTool({ name: 'commit_approved', arguments: { confirmation_id: prepared.confirmation_id, approval: '' } });
console.log(`  ${noApproval.isError ? 'отказ: ' : 'НЕ ОТКАЗАНО: '}${text(noApproval).slice(0, 120)}`);
if (!noApproval.isError) throw new Error('без согласия запись не должна применяться');

step('6. Человек в чате: «да, записывай» → агент commit_approved с его ответом');
const committed = await host.callTool({ name: 'commit_approved', arguments: { confirmation_id: prepared.confirmation_id, approval: 'да, записывай' } });
console.log(`  ${committed.isError ? 'ОШИБКА: ' : ''}${text(committed)}`);

step('7. Запись в базе знаний: автор — человек, агент отмечен');
const after = JSON.parse(text(await host.callTool({ name: 'task', arguments: { task_id: target.id } })));
const note = after.notes.find((n: { title: string }) => n.title.startsWith('Итог (демо)'));
console.log(`  #${note?.id} автор: ${note?.author}, подготовил: ${note?.agent}`);

await plain.close();
await host.close();
await setAccess([]);   // возвращаем как было: тул снова открыт только владельцу
