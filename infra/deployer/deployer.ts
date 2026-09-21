/**
 * Деплоер: единственный, кто выкатывает тулы. Доверенный сервис платформы, а не джоба CI.
 *
 * CI в Gitea только проверяет ветку (контракт допуска, типы) — без секретов и без Docker,
 * потому что workflow берётся из самой ветки и его может переписать кто угодно с правом пуша.
 * Деплоер ждёт зелёный CI по коммиту и выкатывает его своим кодом: charts/tool-base/deploy.ts
 * и Dockerfile — из образа деплоера (main на момент сборки стенда), из ветки берётся только дерево тулов и пакетов.
 *
 *   main        → прод всех тулов
 *   любая ветка → превью изменённых тулов <тул>--<ветка>
 *
 * Итог пишется в Gitea статусом коммита «sandbox / deploy», лог — GET /deploys/<sha> (порт 18090 на localhost).
 * Ветку удалили — её превью отзываются в гейтвее, уборщик удаляет контейнеры.
 * Уведомления (через сервис уведомлений): выкатка упала — автору коммита и владельцам тулов; PR с зелёной выкаткой
 * ждёт одобрения — одобряющим; превью брошенной ветки убрано — автору ветки и владельцам тулов.
 * Без npm-зависимостей: fetch, git, node:http.
 */
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GITEA_URL = process.env.GITEA_URL ?? 'http://gitea:3000';
const REPO = 'platform/internal-tools';
const GITEA_AUTH = Buffer.from(`${process.env.GITEA_DEPLOYER_USER}:${process.env.GITEA_DEPLOYER_PASSWORD}`).toString('base64');
const PUBLIC_URL = process.env.DEPLOYER_PUBLIC_URL ?? 'http://localhost:18090';
const STATE_DIR = process.env.STATE_DIR ?? '/state';
const WORK_DIR = process.env.WORK_DIR ?? '/work/repo';
const DEPLOY_SCRIPT = join(import.meta.dirname, '..', '..', 'charts', 'tool-base', 'deploy.ts');
const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://gateway:8080';
const DEPLOY_TOKEN = process.env.GATEWAY_DEPLOY_TOKEN;
const POLL_MS = Number(process.env.POLL_SECONDS ?? 5) * 1000;
// Ветка без коммитов столько дней — брошена: превью не выкатывается, живое отзывается. Новый коммит оживляет.
const PREVIEW_STALE_DAYS = Number(process.env.PREVIEW_STALE_DAYS ?? 7);
const NOTIFIER_URL = process.env.NOTIFIER_URL ?? 'http://notifier:8080';
const NOTIFY_TOKEN = process.env.NOTIFY_DEPLOYER_TOKEN ?? '';
const GITEA_PUBLIC = process.env.GITEA_PUBLIC_URL ?? 'http://localhost:13000';
// Сервисные учётки Gitea — не люди: уведомления об их коммитах идут по e-mail автора и владельцам тулов.
const SERVICE_USERS = new Set(['sandbox-agent', 'sandbox-deployer', 'sandbox-admin', process.env.GITEA_DEPLOYER_USER]);
const CI_CONTEXT = 'tools / pipeline (push)';
const DEPLOY_CONTEXT = 'sandbox / deploy';

type State = 'waiting' | 'running' | 'success' | 'failure' | 'skipped';
interface Deploy { sha: string; branch: string; state: State; started_at?: string; finished_at?: string; log: string }

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

// ---------- состояние: какой коммит какой ветки уже обработан ------------------------------

mkdirSync(join(STATE_DIR, 'deploys'), { recursive: true });
const DONE_FILE = join(STATE_DIR, 'done.json');
const done: Record<string, string> = existsSync(DONE_FILE) ? JSON.parse(readFileSync(DONE_FILE, 'utf8')) : {};
const markDone = (branch: string, sha: string) => {
  done[branch] = sha;
  writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
};
const deployFile = (sha: string) => join(STATE_DIR, 'deploys', `${sha}.json`);
const saveDeploy = (d: Deploy) => writeFileSync(deployFile(d.sha), JSON.stringify(d));
const loadDeploy = (sha: string): Deploy | null => (existsSync(deployFile(sha)) ? JSON.parse(readFileSync(deployFile(sha), 'utf8')) : null);

// ---------- Gitea -------------------------------------------------------------------------

async function gitea<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${GITEA_URL}/api/v1/repos/${REPO}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Basic ${GITEA_AUTH}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Gitea ${path}: ${res.status} ${await res.text().catch(() => '')}`.trim());
  return (await res.json()) as T;
}

interface Branch { name: string; commit: { id: string; timestamp: string } }
interface CombinedStatus { statuses: { context: string; status: string }[] | null }

async function ciStatus(sha: string): Promise<string | null> {
  const s = await gitea<CombinedStatus>(`/commits/${sha}/status`);
  return s.statuses?.find((x) => x.context === CI_CONTEXT)?.status ?? null;
}

async function report(sha: string, state: 'pending' | 'success' | 'failure', description: string) {
  await gitea(`/statuses/${sha}`, { state, context: DEPLOY_CONTEXT, description: description.slice(0, 250), target_url: `${PUBLIC_URL}/deploys/${sha}` })
    .catch((e: Error) => log({ type: 'status_failed', sha, error: e.message }));
}

// ---------- уведомления ---------------------------------------------------------------------

/** Кому сообщать о коммите: логин автора в Gitea (если это человек) и его e-mail — справочник разберётся. */
async function authorOf(sha: string): Promise<string[]> {
  const c = await gitea<{ author: { login: string } | null; commit: { author: { email: string } } }>(`/git/commits/${sha}`).catch(() => null);
  if (!c) return [];
  return [c.author && !SERVICE_USERS.has(c.author.login) ? c.author.login : null, c.commit.author.email].filter((x): x is string => !!x);
}

/** Владелец тула из выкачиваемого дерева (tool.yaml плоский — хватает регулярного выражения). */
function ownerOf(tool: string): string | null {
  const f = join(WORK_DIR, 'tools', tool, 'tool.yaml');
  return existsSync(f) ? (readFileSync(f, 'utf8').match(/^owner:\s*([a-z][a-z0-9._-]+)/m)?.[1] ?? null) : null;
}

/** Ошибка уведомления не ломает выкатку: в лог, повтор при следующем событии; key не даёт задвоить. */
async function notify(n: { to: string[]; event: string; key: string; subject: string; text: string; link: string }) {
  try {
    const res = await fetch(`${NOTIFIER_URL}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${NOTIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(n),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return true;
  } catch (e) {
    log({ type: 'notify_failed', event: n.event, key: n.key, error: (e as Error).message });
    return false;
  }
}

/** Тулы, на которых выкатка упала: секции «▶ <тул>» лога, в которых есть «✗». */
function failedTools(logText: string): string[] {
  return logText.split(/^▶ /m).slice(1).filter((sec) => sec.includes('✗')).map((sec) => sec.split(/[\s\n]/)[0]!).filter(Boolean);
}

async function notifyFailure(d: Deploy): Promise<void> {
  const tools = failedTools(d.log);
  const owners = tools.map(ownerOf).filter((x): x is string => !!x);
  const reason = (d.log.match(/✗ (.+)/)?.[1] ?? 'ошибка').replace(/[\s:]+$/, '');
  await notify({
    to: [...(await authorOf(d.sha)), ...owners, ...(d.branch === 'main' ? ['sandbox-admins'] : [])],
    event: 'deploy.failed', key: `deploy-failed:${d.sha}`, link: `${PUBLIC_URL}/deploys/${d.sha}`,
    subject: `Выкатка ${d.branch === 'main' ? 'прода' : `ветки ${d.branch}`} упала${tools.length ? `: ${tools.join(', ')}` : ''}`,
    text: `Коммит ${d.sha.slice(0, 7)}: ${reason}. Полный лог — по ссылке; агенту — get_logs. ${d.branch === 'main' ? 'Прод остался на предыдущей версии.' : 'Превью не обновилось.'}`,
  });
}

interface Pull { number: number; title: string; html_url: string; head: { ref: string; sha: string } }
interface Review { state: string; stale?: boolean; dismissed?: boolean }
const prNotified = new Set<string>();

/** PR с зелёным CI и выкаткой превью, но без одобрения — одобряющим песочницы. На каждый новый коммит — заново. */
async function notifyPendingPulls(): Promise<void> {
  const pulls = await gitea<Pull[]>('/pulls?state=open&limit=50');
  for (const p of pulls) {
    const key = `pr:${p.number}:${p.head.sha}`;
    if (prNotified.has(key) || done[p.head.ref] !== p.head.sha || loadDeploy(p.head.sha)?.state !== 'success') continue;
    const reviews = await gitea<Review[]>(`/pulls/${p.number}/reviews`);
    const approved = reviews.some((r) => r.state === 'APPROVED' && !r.stale && !r.dismissed);
    const previews = [...(loadDeploy(p.head.sha)?.log ?? '').matchAll(/web: (\S+)/g)].map((m) => m[1]);
    if (approved || await notify({
      to: ['sandbox-approvers'], event: 'pr.waiting', key, link: p.html_url,
      subject: `PR #${p.number} ждёт одобрения: ${p.title}`,
      text: `CI зелёный${previews.length ? `, превью: ${previews.join(' ')}` : ', превью у ветки нет (тулы не менялись)'}. Посмотрите, одобрите и влейте в Gitea — после мержа деплоер выкатит прод.`,
    })) prNotified.add(key);
  }
}

// ---------- выкатка -----------------------------------------------------------------------

function git(args: string[]): void {
  const r = spawnSync('git', ['-c', `http.extraHeader=Authorization: Basic ${GITEA_AUTH}`, ...args], { cwd: WORK_DIR, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr.trim()}`);
}

function checkout(sha: string): void {
  if (!existsSync(join(WORK_DIR, '.git'))) {
    mkdirSync(WORK_DIR, { recursive: true });
    git(['init', '-q']);
    git(['remote', 'add', 'origin', `${GITEA_URL}/${REPO}.git`]);
  }
  git(['fetch', '-q', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  git(['checkout', '-q', '-f', '--detach', sha]);
  git(['clean', '-q', '-fdx']);
}

function runDeploy(d: Deploy): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('node', ['--disable-warning=ExperimentalWarning', DEPLOY_SCRIPT, '--changed'], {
      cwd: WORK_DIR,
      env: { ...process.env, DEPLOY_BRANCH: d.branch },
    });
    const append = (chunk: Buffer) => {
      d.log += chunk.toString();
      saveDeploy(d);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('close', (code) => resolve(code === 0));
  });
}

async function process1(branch: string, sha: string): Promise<void> {
  const ci = await ciStatus(sha);
  if (ci === null || ci === 'pending') return; // CI ещё не закончил — вернёмся на следующем цикле

  if (ci !== 'success') {
    saveDeploy({ sha, branch, state: 'skipped', finished_at: new Date().toISOString(), log: `CI: ${ci} — коммит не выкатывается\n` });
    markDone(branch, sha);
    log({ type: 'skipped', branch, sha, ci });
    return;
  }

  const d: Deploy = { sha, branch, state: 'running', started_at: new Date().toISOString(), log: '' };
  saveDeploy(d);
  await report(sha, 'pending', `выкатка ${branch === 'main' ? 'прода' : 'превью'}…`);
  log({ type: 'deploy_started', branch, sha });

  let ok = false;
  try {
    checkout(sha);
    ok = await runDeploy(d);
  } catch (e) {
    d.log += `\n✗ ${(e as Error).message}\n`;
  }
  d.state = ok ? 'success' : 'failure';
  d.finished_at = new Date().toISOString();
  saveDeploy(d);
  markDone(branch, sha);

  const urls = [...d.log.matchAll(/web: (\S+)/g)].map((m) => m[1]);
  const summary = ok ? (urls.length ? urls.join(' ') : 'тулы не менялись') : (d.log.match(/✗ (.+)/)?.[1] ?? 'ошибка');
  await report(sha, ok ? 'success' : 'failure', summary);
  log({ type: 'deploy_finished', branch, sha, state: d.state });
  if (!ok) await notifyFailure(d);
}

// ---------- превью удалённых веток ----------------------------------------------------------

/**
 * Ветку удалили (например, после мержа) или забросили (нет коммитов PREVIEW_STALE_DAYS) — её превью больше
 * никто не посмотрит. Отзываем их в гейтвее,
 * токены перестают работать сразу, уборщик удаляет контейнеры и образы. Какие инстансы у ветки —
 * из логов её выкаток: «допуск: … инстанс <имя>, …».
 */
async function dropGoneBranches(alive: Set<string>, why: (branch: string) => string, stale: Map<string, string>): Promise<void> {
  const instancesOf = (d: Deploy) => [...d.log.matchAll(/инстанс (\S+?--\S+?),/g)].map((m) => m[1]!);
  const byBranch = new Map<string, { files: string[]; instances: Set<string> }>();
  // Все ветки preview/* выкатываются в общие <тул>--preview: инстанс живой ветки не трогаем.
  const inUse = new Set<string>();
  for (const f of readdirSync(join(STATE_DIR, 'deploys'))) {
    const d = JSON.parse(readFileSync(join(STATE_DIR, 'deploys', f), 'utf8')) as Deploy;
    if (d.branch === 'main') continue;
    if (alive.has(d.branch)) {
      for (const i of instancesOf(d)) inUse.add(i);
      continue;
    }
    const entry = byBranch.get(d.branch) ?? { files: [], instances: new Set() };
    entry.files.push(f);
    for (const i of instancesOf(d)) entry.instances.add(i);
    byBranch.set(d.branch, entry);
  }

  for (const [branch, { files, instances }] of byBranch) {
    let ok = true;
    for (const instance of [...instances].filter((i) => !inUse.has(i))) {
      const res = await fetch(`${GATEWAY_URL}/v1/admin/tools/${instance}/revoke`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${DEPLOY_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: why(branch) }),
      });
      // 404 — уже отозван или удалён: цель достигнута.
      if (!res.ok && res.status !== 404) {
        ok = false;
        log({ type: 'preview_revoke_failed', branch, instance, status: res.status });
      }
    }
    if (!ok) continue; // повторим на следующем цикле
    for (const f of files) unlinkSync(join(STATE_DIR, 'deploys', f));
    delete done[branch];
    writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
    log({ type: 'previews_dropped', branch, reason: why(branch), instances: [...instances] });
    // Удалённая ветка (обычно после мержа) — это ожидаемо, молчим. Брошенная — стоит сказать автору.
    const head = stale.get(branch);
    if (head && instances.size) {
      const tools = [...new Set([...instances].map((i) => i.split('--')[0]!))];
      await notify({
        to: [...(await authorOf(head)), ...tools.map(ownerOf).filter((x): x is string => !!x)],
        event: 'preview.dropped', key: `preview-dropped:${branch}:${head}`, link: `${GITEA_PUBLIC}/${REPO}/src/branch/${branch}`,
        subject: `Превью ветки ${branch} убрано: ${PREVIEW_STALE_DAYS} дн. без коммитов`,
        text: `Убраны: ${[...instances].join(', ')}. Ветка осталась — новый коммит выкатит превью заново. Не нужна — удалите ветку.`,
      });
    }
  }
}

async function sweep(): Promise<void> {
  const branches = await gitea<Branch[]>('/branches?limit=100');
  const existing = new Set(branches.map((b) => b.name));
  const staleBefore = Date.now() - PREVIEW_STALE_DAYS * 86_400_000;
  const fresh = (b: Branch) => b.name === 'main' || new Date(b.commit.timestamp).getTime() > staleBefore;
  const alive = new Set(branches.filter(fresh).map((b) => b.name));
  const stale = new Map(branches.filter((b) => !fresh(b)).map((b) => [b.name, b.commit.id]));
  await dropGoneBranches(alive, (branch) =>
    existing.has(branch) ? `ветка ${branch} без коммитов ${PREVIEW_STALE_DAYS} дн. — брошена` : `ветка ${branch} удалена`, stale);
  // main первым: прод важнее превью.
  branches.sort((a, b) => Number(b.name === 'main') - Number(a.name === 'main'));
  for (const b of branches) {
    if (!alive.has(b.name) || done[b.name] === b.commit.id) continue;
    await process1(b.name, b.commit.id);
  }
  await notifyPendingPulls().catch((e: Error) => log({ type: 'pulls_check_failed', error: e.message }));
}

// ---------- лог выкатки для агента и человека (только чтение) ---------------------------

// Логи тула — для get_logs агента, в том числе с другого устройства. Только по учётке Gitea: логи тулов
// содержат логины людей и ошибки с данными. Проверка — запрос к Gitea с теми же Basic-учётными данными.
const authCache = new Map<string, number>();
async function giteaUser(header: string | undefined): Promise<boolean> {
  if (!header?.startsWith('Basic ')) return false;
  if ((authCache.get(header) ?? 0) > Date.now()) return true;
  const res = await fetch(`${GITEA_URL}/api/v1/user`, { headers: { Authorization: header } }).catch(() => null);
  if (!res?.ok) return false;
  authCache.set(header, Date.now() + 60_000);
  return true;
}

function toolLogs(instance: string, lines: number): { state: string; logs: string } | null {
  const container = `tool-${instance}`;
  // Только контейнеры тулов: по метке каркаса, а не по имени из запроса.
  const label = spawnSync('docker', ['inspect', '-f', '{{index .Config.Labels "sandbox.instance"}}', container], { encoding: 'utf8' });
  if (label.status !== 0 || label.stdout.trim() !== instance) return null;
  const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}} / health={{.State.Health.Status}}', container], { encoding: 'utf8' }).stdout.trim();
  const out = spawnSync('docker', ['logs', '--tail', String(lines), container], { encoding: 'utf8' });
  return { state, logs: `${out.stdout}${out.stderr}` };
}

http
  .createServer(async (req, res) => {
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    if (req.url === '/healthz') {
      res.end('ok');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://deployer');
    const logsMatch = url.pathname.match(/^\/logs\/([a-z0-9][a-z0-9-]{0,80})$/);
    if (logsMatch) {
      if (!(await giteaUser(req.headers.authorization))) {
        json(401, { error: 'unauthorized', message: 'нужна учётная запись Gitea (Basic)' });
        return;
      }
      const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 100, 10), 500);
      const l = toolLogs(logsMatch[1]!, lines);
      if (!l) json(404, { error: 'not_found', message: `контейнера тула ${logsMatch[1]} нет` });
      else json(200, l);
      return;
    }
    // Последние выкатки — для главной (страница «Платформа»): без логов, лог — по /deploys/<sha>.
    if (url.pathname === '/deploys') {
      const recent = readdirSync(join(STATE_DIR, 'deploys'))
        .map((f) => JSON.parse(readFileSync(join(STATE_DIR, 'deploys', f), 'utf8')) as Deploy)
        .sort((a, b) => String(b.finished_at ?? b.started_at ?? '').localeCompare(String(a.finished_at ?? a.started_at ?? '')))
        .slice(0, 15)
        .map(({ log: _, ...d }) => d);
      json(200, { deploys: recent });
      return;
    }
    const m = url.pathname.match(/^\/deploys\/([0-9a-f]{7,40})$/);
    const d = m ? loadDeploy(m[1]!) : null;
    if (!d) {
      res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ state: 'waiting', message: 'выкатки этого коммита ещё не было' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(d));
  })
  .listen(8080);

log({ type: 'started', poll_seconds: POLL_MS / 1000, handled_branches: Object.keys(done).length });
const loop = async () => {
  await sweep().catch((e: Error) => log({ type: 'error', error: e.message }));
  setTimeout(loop, POLL_MS);
};
void loop();
