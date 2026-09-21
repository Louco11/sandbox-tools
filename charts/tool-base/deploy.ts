/**
 * Единственный способ выкатить тул. Вызывает деплоер (infra/deployer) после зелёного CI; вручную — `make deploy TOOL=…`.
 * Рабочий каталог — дерево выкатываемого коммита; сам скрипт и Dockerfile — из доверенной копии каркаса
 * (в деплоере — из main на момент сборки стенда), поэтому ветка не может поменять то, как её выкатывают.
 *
 *   node charts/tool-base/deploy.ts <tool>                     прод-инстанс
 *   node charts/tool-base/deploy.ts <tool> --preview <branch>  превью <tool>--<ветка>, TTL ≤ 7 дней
 *   node charts/tool-base/deploy.ts --changed                  main → прод всех тулов, ветка → превью изменённых
 *
 * Шаги: гейтвей валидирует манифест и выдаёт секрет → сборка общего образа →
 * контейнер только в сети tools (без выхода куда-либо, кроме гейтвея) → роут в Traefik.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:18080';
const GATEWAY_FOR_TOOLS = 'http://gateway.internal:8080';
const PUBLIC_PORT = process.env.TOOLS_PUBLIC_PORT ?? '18000';
const DEPLOY_TOKEN = process.env.GATEWAY_DEPLOY_TOKEN ?? readDotEnv('GATEWAY_DEPLOY_TOKEN');
const DOCKERFILE = join(import.meta.dirname, 'Dockerfile');
// Домен витрины: tools.localhost на самом стенде, tools.<ip>.sslip.io в локальной сети (make lan).
const DOMAIN = process.env.SANDBOX_DOMAIN ?? readDotEnv('SANDBOX_DOMAIN') ?? 'tools.localhost';
// Превью всех тулов — только если ветка меняет то, что попадает в образ тула: SDK и ui-kit (packages/).
// charts/tool-base деплоер берёт из своей доверенной копии, а не из ветки, — правка там превью не меняет.
// gateway/, infra/, portal/ и прочий каркас ветка не превьюит вовсе (AGENTS.md). package-lock — не в счёт.
const FRAMEWORK_PATHS = ['packages/'];

function readDotEnv(key: string): string | undefined {
  if (!existsSync('.env')) return undefined;
  const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim();
}

function sh(cmd: string, args: string[], opts: { quiet?: boolean } = {}): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'] }).trim();
}

function allTools(): string[] {
  return readdirSync('tools', { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`tools/${d.name}/tool.yaml`))
    .map((d) => d.name);
}

interface Registered {
  access_warning?: string;
  tool: string;
  client_secret: string;
  expires_at: string;
}

class Retired extends Error {
  tool: string;
  constructor(tool: string, reason: string) {
    super(reason);
    this.tool = tool;
  }
}

async function register(tool: string, branch?: string, attempt = 1): Promise<Registered> {
  const manifest = parse(readFileSync(`tools/${tool}/tool.yaml`, 'utf8'));
  // Гейтвей может перезапускаться (пересборка, миграция). Это не «тул не собрался» — ждём и повторяем.
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEPLOY_TOKEN}` },
    body: JSON.stringify({ manifest, preview: branch ? { branch } : undefined }),
  }).catch(async (e: Error) => {
    if (attempt >= 10) throw new Error(`гейтвей недоступен (${e.message}) — ${attempt} попыток за ${attempt * 3} с`);
    console.log(`  гейтвей не отвечает (${e.message}), попытка ${attempt} — жду 3 с`);
    await new Promise((r) => setTimeout(r, 3000));
    return null;
  });
  if (res === null) return register(tool, branch, attempt + 1);
  const body = (await res.json()) as Registered & { message?: string; errors?: { path: string; message: string }[] };
  // Прод-тул, который владелец удалил (отозвал), обратно не пускается. Код уберёт отдельный PR — CI при этом не краснеет.
  if (res.status === 403 && !branch && /отозван/.test(body.message ?? '')) throw new Retired(tool, body.message ?? '');
  if (!res.ok) {
    const details = body.errors?.map((e) => `  ${e.path}: ${e.message}`).join('\n') ?? `  ${body.message}`;
    throw new Error(`гейтвей не допустил ${tool} в контур:\n${details}`);
  }
  return body;
}

async function waitHealthy(container: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const status = sh('docker', ['inspect', '-f', '{{.State.Health.Status}}', container], { quiet: true });
    if (status === 'healthy') return;
    if (status === 'unhealthy') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const logs = spawnSync('docker', ['logs', '--tail', '40', container], { encoding: 'utf8' });
  throw new Error(`тул не поднялся (${container}):\n${logs.stdout}${logs.stderr}`);
}

async function deploy(tool: string, branch?: string): Promise<void> {
  const started = Date.now();
  console.log(`\n▶ ${tool}${branch ? ` (превью ветки ${branch})` : ''}`);

  const { tool: instance, client_secret, expires_at, access_warning } = await register(tool, branch);
  console.log(`  допуск: гейтвей принял манифест, инстанс ${instance}, живёт до ${expires_at}`);
  // Живой круг доступа меняет человек на главной, и он главнее манифеста — но молчать о расхождении нельзя.
  if (access_warning) console.log(`  внимание: ${access_warning}`);

  const image = `sandbox-tool/${instance}:latest`;
  sh('docker', ['build', '-q', '-f', DOCKERFILE, '--build-arg', `TOOL=${tool}`, '-t', image, '.']);
  console.log(`  образ: ${image}`);

  const container = `tool-${instance}`;
  spawnSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
  const owner = String(parse(readFileSync(`tools/${tool}/tool.yaml`, 'utf8')).owner);
  const labels: Record<string, string> = {
    'traefik.enable': 'true',
    'traefik.docker.network': 'sandbox_tools',
    [`traefik.http.routers.${instance}.rule`]: `Host(\`${instance}.${DOMAIN}\`)`,
    [`traefik.http.routers.${instance}.entrypoints`]: 'web',
    // Оба фасада — только после входа в IdP: Traefik вырезает чужой X-Sandbox-Identity и спрашивает identity.
    // Браузер приходит с кукой сессии, MCP-хост — с сессией от device flow в заголовке Authorization.
    [`traefik.http.routers.${instance}.middlewares`]: 'strip-identity@docker,sandbox-auth@docker',
    [`traefik.http.services.${instance}.loadbalancer.server.port`]: '3000',
    'sandbox.tool': tool,
    'sandbox.instance': instance,
    'sandbox.owner': owner,
    'sandbox.expires_at': expires_at,
  };
  sh('docker', [
    'run', '-d', '--name', container,
    '--network', 'sandbox_tools',
    '--read-only', '--tmpfs', '/tmp',
    '--memory', '256m', '--cpus', '0.5', '--pids-limit', '128',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--restart', 'unless-stopped',
    '-e', `GATEWAY_URL=${GATEWAY_FOR_TOOLS}`,
    '-e', `TOOL_INSTANCE=${instance}`,
    '-e', `TOOL_CLIENT_SECRET=${client_secret}`,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    image,
  ], { quiet: true });

  await waitHealthy(container);
  const url = `http://${instance}.${DOMAIN}:${PUBLIC_PORT}`;
  console.log(`  готово за ${Math.round((Date.now() - started) / 1000)} с`);
  console.log(`  web: ${url}`);
  console.log(`  mcp: ${url}/mcp`);
}

function changedTools(): { tools: string[]; branch: string; preview: boolean } {
  const branch = process.env.DEPLOY_BRANCH ?? sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === 'main') return { tools: allTools(), branch, preview: false };

  const diff = sh('git', ['diff', '--name-only', 'origin/main...HEAD'], { quiet: true }).split('\n').filter(Boolean);
  const framework = diff.some((f) => FRAMEWORK_PATHS.some((p) => f.startsWith(p)));
  const touched = new Set(diff.filter((f) => f.startsWith('tools/')).map((f) => f.split('/')[1]!));
  const tools = allTools().filter((t) => framework || touched.has(t));
  return { tools, branch, preview: true };
}

async function main() {
  if (!DEPLOY_TOKEN) throw new Error('нет GATEWAY_DEPLOY_TOKEN');
  const args = process.argv.slice(2);

  if (args[0] === '--changed') {
    const { tools, branch, preview } = changedTools();
    if (!tools.length) {
      console.log(`В ветке ${branch} тулы не менялись — деплоить нечего.`);
      return;
    }
    // Истёкший или отозванный тул пропускаем с подсказкой; другая ошибка одного тула не мешает выкатить
    // остальные, но выкатку в целом роняет.
    const failed: string[] = [];
    for (const t of tools) {
      try {
        await deploy(t, preview ? branch : undefined);
      } catch (e) {
        if (e instanceof Retired) {
          console.log(`  пропущен: ${e.message}. Код тула ещё в main — уберите его PR (кнопка на главной странице песочницы)`);
        } else {
          console.error(`  ✗ ${(e as Error).message}`);
          failed.push(t);
        }
      }
    }
    if (failed.length) throw new Error(`не выкачены: ${failed.join(', ')}`);
    return;
  }

  const [tool, flag, branch] = args;
  if (!tool || !existsSync(`tools/${tool}/tool.yaml`)) throw new Error(`нет tools/${tool ?? '<tool>'}/tool.yaml`);
  await deploy(tool, flag === '--preview' ? branch : undefined);
}

main().catch((e: Error) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
