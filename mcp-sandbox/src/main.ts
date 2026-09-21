/**
 * mcp-sandbox — песочница как MCP-сервер для build-time агента.
 * Глаголы вместо знания про Docker, сети, секреты и CI:
 *   тул:        list_sources → scaffold_tool → validate_manifest → deploy_preview → get_logs → open_pull_request
 *   коннектор:  scaffold_connector → validate_connector → open_pull_request (источник одобряет человек)
 *
 * У этого сервера нет доступа к данным и нет сервисных токенов гейтвея. Превью выкатывает деплоер
 * после зелёного CI в Gitea — тех же проверок, что и для любого коммита.
 *
 * Запуск (stdio, из корня репозитория): node mcp-sandbox/src/main.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { stringify } from 'yaml';
import { z } from 'zod';
import { UI_MODES, loadRegistry, validateManifest } from '@sandbox/manifest';
import { sync as syncAgentConfigs } from '../../infra/agents/sync.ts';
import { loadKey, KEY_ENV } from '../../infra/mcp-key.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');

function envOr(key: string): string | undefined {
  if (!existsSync(join(ROOT, '.env'))) return undefined;
  const line = readFileSync(join(ROOT, '.env'), 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}
function env(key: string): string {
  const v = envOr(key);
  if (!v) throw new Error(`нет ${key} в .env — стенд поднят через make up (или рабочая копия подключена через infra/remote.sh)?`);
  return v;
}

// Стенд — на этом устройстве (localhost) или на другом в локальной сети (SANDBOX_HOST из make lan / infra/remote.sh).
const HOST = process.env.SANDBOX_HOST ?? envOr('SANDBOX_HOST') ?? 'localhost';
const DOMAIN = process.env.SANDBOX_DOMAIN ?? envOr('SANDBOX_DOMAIN') ?? 'tools.localhost';
const GATEWAY_URL = process.env.GATEWAY_URL ?? `http://${HOST}:18080`;
const GITEA_URL = process.env.GITEA_URL ?? `http://${HOST}:13000`;
const REPO = 'platform/internal-tools';
const PUBLIC_PORT = '18000';

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});
const fail = (message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }] });
const guard = async (fn: () => Promise<ReturnType<typeof ok | typeof fail>>) => {
  try {
    return await fn();
  } catch (e) {
    return fail((e as Error).message);
  }
};

const toolDir = (name: string) => join(ROOT, 'tools', name);
const nameSchema = z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/).min(3).max(40);

// ---------- доступ к репозиторию: от имени человека, а не общей учётки ---------------------------

/**
 * Шаг Б6: у каждого человека свой бот `<логин>-agent`. Агент приходит с личным ключом человека
 * (`bin/sandbox-mcp login`), сервис личности проверяет группу `sandbox-developers` и выдаёт короткоживущий
 * токен бота. Пароля администратора Gitea и общей учётки `sandbox-agent` на машине разработчика больше нет,
 * а в истории репозитория видно, чей агент пушил.
 */
const IDENTITY_URL = process.env.IDENTITY_URL ?? `http://id.${DOMAIN}:${PUBLIC_PORT}`;
interface Forge { user: string; token: string; expires_at: string; owner: string }
let forge: Forge | null = null;

async function forgeAccess(): Promise<Forge> {
  if (forge && new Date(forge.expires_at).getTime() > Date.now() + 60_000) return forge;
  const key = loadKey(`${DOMAIN}:${PUBLIC_PORT}`);
  if (!key) {
    throw new Error(
      `нет личного ключа MCP. Один раз выполните: bin/sandbox-mcp login\n`
      + `Ключ ляжет в Keychain (или ~/.sandbox); в конфигах агента его нет. Можно передать и через ${KEY_ENV}.`,
    );
  }
  const res = await fetch(`${IDENTITY_URL}/forge/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => {
    throw new Error(`сервис личности недоступен (${IDENTITY_URL}): ${e.message}`);
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & Forge;
  if (!res.ok) throw new Error(body.error ?? `сервис личности: ${res.status}`);
  forge = body;
  return body;
}

/** Для Gitea и деплоера — Basic с токеном бота: так же, как человек ходил бы своей учёткой. */
const forgeAuth = async () => {
  const f = await forgeAccess();
  return Buffer.from(`${f.user}:${f.token}`).toString('base64');
};

async function gitea<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(`${GITEA_URL}/api/v1/repos/${REPO}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Basic ${await forgeAuth()}`, 'Content-Type': 'application/json' },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`Gitea ${path}: ${res.status} ${await res.text().catch(() => '')}`.trim());
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('json') ? await res.json() : await res.text()) as T;
}

interface Run {
  id: number;
  run_number: number;
  status: string;
  head_sha: string;
  head_branch: string;
}

async function waitRun(sha: string, timeoutMs = 10 * 60_000): Promise<Run> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const { workflow_runs } = await gitea<{ workflow_runs: Run[] }>('/actions/tasks?limit=50');
    const r = workflow_runs.find((w) => w.head_sha === sha);
    if (r && ['success', 'failure', 'cancelled', 'skipped'].includes(r.status)) return r;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('CI не завершился за 10 минут');
}

// ---------- деплоер ----------------------------------------------------------------

const DEPLOYER_URL = process.env.DEPLOYER_URL ?? `http://${HOST}:18090`;

interface Deploy { state: 'waiting' | 'running' | 'success' | 'failure' | 'skipped'; log: string }

async function deployOf(sha: string): Promise<Deploy> {
  const res = await fetch(`${DEPLOYER_URL}/deploys/${sha}`).catch(() => null);
  if (!res) throw new Error(`деплоер недоступен (${DEPLOYER_URL}) — стенд поднят через make up?`);
  return (await res.json()) as Deploy;
}

/** Деплоер подхватывает коммит после зелёного CI; ждём, пока он закончит выкатку. */
async function waitDeploy(sha: string, timeoutMs = 10 * 60_000): Promise<Deploy> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const d = await deployOf(sha);
    if (['success', 'failure', 'skipped'].includes(d.state)) return d;
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error('деплоер не закончил выкатку за 10 минут');
}

async function runLog(r: Run): Promise<string> {
  const raw = await gitea<string>(`/actions/jobs/${r.id}/logs`);
  return raw
    .split('\n')
    .map((l) => l.replace(/^\S+Z /, ''))
    .filter((l) => /✓|✗|тулов прошли|▶|допуск:|образ:|готово за|web:|mcp:|^\s{4}\S|error TS|не допустил|не поднялся|деплоить нечего|Error:/.test(l))
    .filter((l) => !l.startsWith('::'))
    .join('\n');
}

// ---------- сервер -----------------------------------------------------------------

const server = new McpServer({ name: 'mcp-sandbox', version: '0.1.0' });

server.registerTool(
  'list_sources',
  {
    description:
      'Реестр одобренных источников данных и прав на запись: наборы, поля, уровень чувствительности. Тул может использовать только то, что здесь есть',
  },
  () =>
    guard(async () => {
      const res = await fetch(`${GATEWAY_URL}/v1/registry`).catch(() => null);
      if (res?.ok) return ok(await res.json());
      const reg = loadRegistry(join(ROOT, 'registry', 'sources.yaml'));
      return ok({ note: 'гейтвей недоступен, показан локальный реестр', ...reg });
    }),
);

server.registerTool(
  'scaffold_tool',
  {
    description:
      'Создать тул из шаблона: tools/<name>/ с tool.yaml, src/server.ts, ui/app.tsx, AGENTS.md. Манифест сразу проверяется против реестра',
    inputSchema: {
      name: nameSchema.describe('slug тула, например team-workload-report'),
      title: z.string().min(3).describe('название для людей'),
      description: z.string().min(10).describe('какую задачу бизнеса решает'),
      owner: z.string().min(2).describe('логин человека-владельца, отвечает за продление'),
      sources: z.array(z.string()).describe('id источников из list_sources'),
      writes: z.array(z.string()).default([]).describe('id прав на запись из list_sources, если нужны'),
      ui_modes: z.array(z.enum(UI_MODES)).default(['web', 'mcp-app']),
      ttl_days: z.number().int().positive().default(30),
    },
  },
  (input) =>
    guard(async () => {
      const registry = loadRegistry(join(ROOT, 'registry', 'sources.yaml'));
      const manifest = {
        name: input.name,
        owner: input.owner,
        ttl_days: input.ttl_days,
        sources: input.sources,
        writes: input.writes,
        ui: { mode: input.ui_modes },
      };
      const check = validateManifest(manifest, registry);
      if (!check.ok) return fail(`Манифест не пройдёт контракт допуска:\n${check.errors.map((e) => `- ${e.path}: ${e.message}`).join('\n')}`);

      const dir = toolDir(input.name);
      if (existsSync(dir)) return fail(`tools/${input.name} уже существует`);

      const exampleSource = input.sources[0];
      const exampleDataset = exampleSource ? Object.keys(registry.sources[exampleSource]!.datasets)[0]! : '';
      cpSync(join(ROOT, 'templates', 'new-tool'), dir, { recursive: true });
      const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
      for (const f of files) {
        const p = join(f.parentPath, f.name);
        const text = readFileSync(p, 'utf8')
          .replaceAll('__TOOL_NAME__', input.name)
          .replaceAll('__TITLE__', input.title.replaceAll("'", "\\'"))
          .replaceAll('__DESCRIPTION__', input.description.replaceAll("'", "\\'"))
          .replaceAll('__EXAMPLE_SOURCE__', exampleSource ?? '')
          .replaceAll('__EXAMPLE_DATASET__', exampleDataset);
        writeFileSync(p, text);
      }
      // Отметка начала работы — для метрики «время от задачи до превью» на главной. Комментарий, не поле контракта.
      writeFileSync(join(dir, 'tool.yaml'), `# начат: ${new Date().toISOString()}\n${stringify(manifest)}`);

      const install = run('npm', ['install', '--no-audit', '--no-fund']);
      if (!install.ok) return fail(`npm install не прошёл:\n${install.out}`);
      // Новый тул сразу доступен всем агентам как MCP-сервер sandbox-<имя>.
      const agentConfigs = syncAgentConfigs();

      return ok({
        created: [...files.map((f) => relative(ROOT, join(f.parentPath, f.name))), `tools/${input.name}/tool.yaml`].sort(),
        agent_configs: agentConfigs,
        example: exampleSource
          ? `src/server.ts читает ${exampleSource}/${exampleDataset} — замените на логику задачи`
          : 'источников нет — действие-пример надо переписать',
        next: [
          `Прочитайте tools/${input.name}/AGENTS.md`,
          'Логика — в src/server.ts (action + ctx.query / ctx.prepareWrite), интерфейс — в ui/app.tsx (@sandbox/ui-kit)',
          `validate_manifest { name: "${input.name}" }`,
          'git add + commit (tools/<name>, package-lock.json и конфиги агентов: .mcp.json, .cursor/mcp.json, opencode.json)',
          `deploy_preview { name: "${input.name}" } — вернёт ссылку для заказчика`,
          `open_pull_request { name: "${input.name}", … } — когда заказчик доволен превью; мержит человек`,
        ],
      });
    }),
);

// ---------- коннекторы источников ---------------------------------------------------

const CONNECTOR_KINDS = ['sql', 'api', 'mcp'] as const;

server.registerTool(
  'scaffold_connector',
  {
    description:
      'Создать коннектор источника из шаблона: connectors/<name>/ (server.ts, test.ts на тестовых данных, черновик реестра). ' +
      'kind: sql — база данных, api — HTTP API, mcp — MCP-сервер системы (без кода, файлом соответствий). ' +
      'Только по задаче на коннектор, не из задачи про тул. Боевых учётных данных агент не получает и не использует',
    inputSchema: {
      name: nameSchema.describe('имя коннектора = системы, например crm или warehouse'),
      kind: z.enum(CONNECTOR_KINDS),
      title: z.string().min(3).describe('название источника для людей'),
      owner: z.string().min(2).describe('логин владельца данных'),
    },
  },
  (input) =>
    guard(async () => {
      const dir = join(ROOT, 'connectors', input.name);
      if (existsSync(dir)) return fail(`connectors/${input.name} уже существует`);
      const source = `${input.name}-readonly`;
      const tokenEnv = `CONNECTOR_${input.name.toUpperCase().replaceAll('-', '_')}_TOKEN`;
      cpSync(join(ROOT, 'templates', 'new-connector', input.kind), dir, { recursive: true });
      const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((f) => f.isFile());
      for (const f of files) {
        const p = join(f.parentPath, f.name);
        writeFileSync(p, readFileSync(p, 'utf8')
          .replaceAll('__NAME__', input.name)
          .replaceAll('__SOURCE__', source)
          .replaceAll('__TITLE__', input.title.replaceAll('"', "'"))
          .replaceAll('__OWNER__', input.owner)
          .replaceAll('__TOKEN_ENV__', tokenEnv)
          .replaceAll('__PREFIX__', input.name));
      }
      const install = run('npm', ['install', '--no-audit', '--no-fund']);
      if (!install.ok) return fail(`npm install не прошёл:\n${install.out}`);
      return ok({
        created: files.map((f) => relative(ROOT, join(f.parentPath, f.name))).sort(),
        source,
        next: [
          'Прочитайте раздел «Задача на коннектор» в AGENTS.md',
          `Замените демо-набор items и запись ${input.name}.item:set_status на наборы и записи системы: ${input.kind === 'mcp' ? 'config.yaml' : 'server.ts'}, registry.draft.yaml`,
          `Тестовая система в test.ts${input.kind === 'sql' ? ' и test/schema.sql' : input.kind === 'mcp' ? ' и fixture/server.ts' : ''} — только выдуманные данные, повторяющие форму настоящих; сценарий на каждую запись`,
          `validate_connector { name: "${input.name}" } — до зелёного`,
          'git add + commit (connectors/<name>, package-lock.json) → open_pull_request { branch, … }',
          'Человек: одобряет источник (переносит черновик в registry/sources.yaml), ставит боевую учётку, сервис и сеть в docker-compose.yml, токен в infra/init-env.sh',
        ],
      });
    }),
);

server.registerTool(
  'validate_connector',
  {
    description:
      'Проверить контракт коннектора на тестовых данных (его test.ts): нет секретов и чужих адресов в коде; без токена гейтвея — отказ; ' +
      'состав совпадает с реестром или черновиком; наборы отдают ровно поля реестра; describe ничего не меняет; apply делает то, что ожидает сценарий',
    inputSchema: { name: nameSchema },
  },
  ({ name }) =>
    guard(async () => {
      if (!existsSync(join(ROOT, 'connectors', name))) return fail(`нет connectors/${name}`);
      const r = run('node', ['--disable-warning=ExperimentalWarning', 'packages/connector/src/validate.ts', name]);
      return r.ok ? ok(r.out) : fail(r.out);
    }),
);

server.registerTool(
  'validate_manifest',
  {
    description:
      'Те же проверки, что в CI: tool.yaml против реестра (с объяснением, почему источник недоступен), запрещённые зависимости и импорты, типы',
    inputSchema: { name: nameSchema },
  },
  ({ name }) =>
    guard(async () => {
      if (!existsSync(toolDir(name))) return fail(`нет tools/${name}`);
      const contract = run('node', ['--disable-warning=ExperimentalWarning', 'packages/manifest/src/cli.ts', name]);
      const types = run('npx', ['tsc', '-p', 'tsconfig.json']);
      const report = `Контракт допуска:\n${contract.out}\n\nТипы: ${types.ok ? 'ок' : `\n${types.out}`}`;
      return contract.ok && types.ok ? ok(report) : fail(report);
    }),
);

server.registerTool(
  'deploy_preview',
  {
    description:
      'Выкатить превью: закоммиченный HEAD уходит в ветку preview/<name> в Gitea, CI проверяет, деплоер выкатывает. Ждёт результат и возвращает ссылку для заказчика или ошибки CI',
    inputSchema: { name: nameSchema },
  },
  ({ name }) =>
    guard(async () => {
      if (!existsSync(toolDir(name))) return fail(`нет tools/${name}`);
      const dirty = run('git', ['status', '--porcelain', '--', `tools/${name}`, 'package.json', 'package-lock.json']).out;
      if (dirty) return fail(`Есть незакоммиченные изменения — превью собирается только из коммита:\n${dirty}`);

      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
      const push = run('git', [
        '-c', 'credential.helper=', '-c', `http.extraHeader=Authorization: Basic ${await forgeAuth()}`,
        'push', '-f', `${GITEA_URL}/${REPO}.git`, `HEAD:refs/heads/preview/${name}`,
      ]);
      if (!push.ok) return fail(`git push не прошёл:\n${push.out}`);

      const started = Date.now();
      const r = await waitRun(sha);
      const log = await runLog(r);
      const link = `${GITEA_URL}/${REPO}/actions/runs/${r.run_number}`;
      const seconds = Math.round((Date.now() - started) / 1000);
      if (r.status !== 'success') return fail(`CI: ${r.status} за ${seconds} с (${link})\n\n${log}`);

      const d = await waitDeploy(sha);
      const total = Math.round((Date.now() - started) / 1000);
      if (d.state !== 'success') return fail(`CI зелёный, выкатка: ${d.state} (${DEPLOYER_URL}/deploys/${sha})\n\n${d.log}`);

      const url = `http://${name}--preview.${DOMAIN}:${PUBLIC_PORT}`;
      return ok({
        status: 'ok', ci_seconds: seconds, total_seconds: total, ci: link, preview: url, mcp: `${url}/mcp`, ttl: 'превью живёт до 7 дней',
        log: `${log}\n\n--- выкатка ---\n${d.log.trim()}`,
        next: `покажите превью человеку; когда он доволен — open_pull_request { name: "${name}" }`,
      });
    }),
);

server.registerTool(
  'get_logs',
  {
    description: 'Логи контейнера тула (превью или прод) и статус последнего прогона CI по ветке превью',
    inputSchema: {
      name: nameSchema,
      preview: z.boolean().default(true),
      lines: z.number().int().min(10).max(500).default(100),
    },
  },
  ({ name, preview, lines }) =>
    guard(async () => {
      // Логи — через деплоер, а не локальный docker: агент может работать с другого устройства.
      const instance = preview ? `${name}--preview` : name;
      const container = `tool-${instance}`;
      const res = await fetch(`${DEPLOYER_URL}/logs/${instance}?lines=${lines}`, { headers: { Authorization: `Basic ${await forgeAuth()}` } })
        .catch(() => null);
      if (!res) throw new Error(`деплоер недоступен (${DEPLOYER_URL})`);
      const body = (await res.json()) as { state?: string; logs?: string; message?: string };
      const state = { ok: res.ok, out: body.state ?? '' };
      const logs = { out: res.ok ? (body.logs ?? '') : (body.message ?? '') };

      let ci = 'нет прогонов';
      const { workflow_runs } = await gitea<{ workflow_runs: Run[] }>('/actions/tasks?limit=50');
      const last = workflow_runs.find((w) => w.head_branch === `preview/${name}`);
      if (last) {
        ci = `${last.status} (${GITEA_URL}/${REPO}/actions/runs/${last.run_number})\n${await runLog(last)}`;
        const d = await deployOf(last.head_sha).catch((e: Error) => ({ state: 'waiting', log: e.message }));
        ci += `\n\n--- выкатка: ${d.state} ---\n${d.log.trim()}`;
      }

      return ok(
        `Контейнер ${container}: ${state.ok ? state.out : 'не запущен'}\n\n--- логи ---\n${logs.out || '(пусто)'}\n\n--- CI preview/${name} ---\n${ci}`,
      );
    }),
);

interface PullRequest {
  number: number;
  html_url: string;
  state: string;
  head: { ref: string };
}

server.registerTool(
  'open_pull_request',
  {
    description:
      'Открыть PR в main после проверенного превью. main защищён: мержит только человек после одобрения и зелёного CI. ' +
      'Для тула head — ветка превью preview/<name> (сначала deploy_preview); для задачи на каркас — укажите branch, уже запушенную в Gitea',
    inputSchema: {
      name: nameSchema.optional().describe('тул, для которого было deploy_preview'),
      branch: z.string().min(1).optional().describe('ветка вместо preview/<name>, например для изменения каркаса'),
      title: z.string().min(5).describe('что меняется, для человека'),
      description: z.string().min(10).describe('зачем, что проверить на превью, какие источники и права записи затронуты'),
    },
  },
  ({ name, branch, title, description }) =>
    guard(async () => {
      const head = branch ?? (name ? `preview/${name}` : null);
      if (!head) return fail('укажите name (тул после deploy_preview) или branch');
      if (head === 'main') return fail('PR из main в main не бывает');

      const open = await gitea<PullRequest[]>('/pulls?state=open&limit=50');
      const existing = open.find((p) => p.head.ref === head);
      if (existing) return ok({ status: 'уже открыт', pr: existing.html_url, next: 'ждите одобрения человеком; новые коммиты в ветку сбросят одобрение' });

      const preview = name ? `http://${name}--preview.${DOMAIN}:${PUBLIC_PORT}` : null;
      const body = [
        description,
        '',
        preview ? `**Превью:** ${preview}` : `**Превью:** тулы, затронутые веткой, выкачены деплоером как \`<тул>--<ветка>.${DOMAIN}:18000\``,
        '',
        `Открыто агентом ${(await forgeAccess()).user} от имени ${(await forgeAccess()).owner} через mcp-sandbox.`,
        'Мерж — только после одобрения человеком и зелёного CI. Свой PR автор не одобряет.',
      ].join('\n');
      const pr = await gitea<PullRequest>('/pulls', { method: 'POST', body: { head, base: 'main', title, body } });
      return ok({ status: 'открыт', pr: pr.html_url, preview, next: 'человек смотрит превью, одобряет и мержит PR в Gitea; после мержа деплоер выкатит прод' });
    }),
);

await server.connect(new StdioServerTransport());
