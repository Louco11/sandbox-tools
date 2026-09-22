/**
 * Данные главной. Гейтвей (тулы, сроки, активность из аудита, здоровье платформы, реестр) — по токену роли portal;
 * Gitea (ветки, PR, CI) — учёткой агента, только чтение; тул (его описание) — GET /_meta по сети тулов;
 * git рабочей копии — смонтирована read-only. Прав на данные источников у главной нет.
 */
import { spawnSync } from 'node:child_process';
import { DOMAIN, GATEWAY_URL, GITEA_AUTH, IDENTITY_TOKEN, GITEA_URL, IDENTITY_URL, NOTIFIER_URL, NOTIFY_TOKEN, PORTAL_TOKEN, PUBLIC_PORT, REPO, WORKTREE } from './config.ts';


export interface GatewayTool {
  name: string;
  owner: string;
  expires_at: string;
  revoked_at: string | null;
  auto_extend_until: string | null;
  last_human_at: string | null;
  idle_notified_at: string | null;
  sources: string[];
  writes: string[];
  /** Кто решает за владельца по справочнику (ушёл — руководитель, группа — участники) и почему. */
  owners: string[];
  owner_note: string | null;
}
export interface Branch { name: string; commit: { id: string; timestamp: string; message: string; author: { name: string } } }
export interface Compare { total_commits: number; commits: { files?: { filename: string }[] }[] }
export interface Pull {
  number: number; title: string; html_url: string; mergeable: boolean; created_at: string;
  user: { login: string }; head: { ref: string; sha: string };
}
export interface Review { user: { login: string }; state: string; stale?: boolean; dismissed?: boolean }
export interface Manifest { owner: string; ttl_days: number; sources: string[]; writes: string[]; started_at: string | null }

/**
 * Доступ к репозиторию от имени человека (шаг Б6, починка Ч5): сервис личности выдаёт токен его бота
 * `<логин>-agent`. Раньше портал писал общей учётной записью, пароль которой лежит в `.env` стенда, —
 * и в истории репозитория было не разобрать, кто на самом деле нажал кнопку.
 */
export async function forgeAs(identity: string): Promise<string> {
  const res = await fetch(`${IDENTITY_URL}/forge/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${IDENTITY_TOKEN}`, 'X-Sandbox-Identity': identity },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string; user?: string; token?: string };
  if (!res.ok || !body.user || !body.token) throw new Error(body.error ?? `сервис личности: ${res.status}`);
  return Buffer.from(`${body.user}:${body.token}`).toString('base64');
}

export async function gitea<T>(path: string, init?: { method: string; body: unknown; auth?: string }): Promise<T> {
  const res = await fetch(`${GITEA_URL}/api/v1/repos/${REPO}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Basic ${init?.auth ?? GITEA_AUTH}`, 'Content-Type': 'application/json' },
    body: init ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`Gitea ${path}: ${res.status} ${init ? await res.text().catch(() => '') : ''}`.trim());
  return (await res.json()) as T;
}

export async function gatewayTools(): Promise<GatewayTool[]> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools`, { headers: { Authorization: `Bearer ${PORTAL_TOKEN}` } });
  if (!res.ok) throw new Error(`гейтвей: ${res.status}`);
  return ((await res.json()) as { tools: GatewayTool[] }).tools;
}

/** Тулы в main: папки tools/<имя> с tool.yaml. Разбор YAML минимальный — манифест плоский. */
export async function mainTools(): Promise<Map<string, Manifest>> {
  const dirs = await gitea<{ name: string; type: string }[]>('/contents/tools?ref=main');
  const out = new Map<string, Manifest>();
  await Promise.all(
    dirs.filter((d) => d.type === 'dir').map(async (d) => {
      const f = await gitea<{ content: string }>(`/contents/tools/${d.name}/tool.yaml?ref=main`).catch(() => null);
      if (f) out.set(d.name, parseManifest(Buffer.from(f.content, 'base64').toString('utf8')));
    }),
  );
  return out;
}

export function parseManifest(text: string): Manifest {
  const scalar = (k: string) => text.match(new RegExp(`^${k}:\\s*(\\S+)`, 'm'))?.[1] ?? '';
  const list = (k: string) => {
    const inline = text.match(new RegExp(`^${k}:\\s*\\[(.*)\\]`, 'm'));
    if (inline) return inline[1]!.split(',').map((s) => s.trim()).filter(Boolean);
    const block = text.match(new RegExp(`^${k}:\\s*\\n((?:\\s+-\\s*.+\\n?)+)`, 'm'));
    return block ? [...block[1]!.matchAll(/-\s*(\S+)/g)].map((m) => m[1]!) : [];
  };
  // «# начат: <время>» ставит scaffold_tool — начало работы над тулом для метрики «время до превью».
  const started = text.match(/^#\s*начат:\s*(\S+)/m)?.[1] ?? null;
  return { owner: scalar('owner'), ttl_days: Number(scalar('ttl_days')), sources: list('sources'), writes: list('writes'), started_at: started };
}

/** Тот же slug, что у гейтвея: инстанс превью — <тул>--<slug ветки>. */
export function branchSlug(branch: string): string {
  if (branch.startsWith('preview/')) return 'preview';
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'branch';
}

export const NEUTRAL = new Set(['package-lock.json', '.mcp.json', '.cursor/mcp.json', 'opencode.json']);

/** Что затрагивают файлы: тулы по именам и признак изменения каркаса. */
export function classify(files: string[]): { tools: string[]; framework: string[] } {
  const tools = new Set<string>();
  const framework = new Set<string>();
  for (const f of files) {
    const m = f.match(/^tools\/([^/]+)\//);
    if (m) tools.add(m[1]!);
    else if (!NEUTRAL.has(f)) framework.add(f);
  }
  return { tools: [...tools].sort(), framework: [...framework].sort() };
}

export interface BranchInfo {
  name: string;
  ahead: number;
  sha: string;
  updated: string;
  author: string;
  message: string;
  ci: string;
  tools: string[];
  framework: string[];
  pr: PullInfo | null;
}
export interface PullInfo {
  number: number; title: string; url: string; author: string; mergeable: boolean; ci: string; head: string;
  approvedBy: string[]; changesRequested: string[];
}

export async function ciState(sha: string): Promise<string> {
  const s = await gitea<{ state: string; total_count: number }>(`/commits/${sha}/status`).catch(() => null);
  return !s || s.total_count === 0 ? 'нет' : s.state;
}

export async function repoState(): Promise<{ branches: BranchInfo[]; merged: string[]; pulls: PullInfo[] }> {
  const [branches, pulls] = await Promise.all([
    gitea<Branch[]>('/branches?limit=100'),
    gitea<Pull[]>('/pulls?state=open&limit=50'),
  ]);

  const pullInfo = new Map<string, PullInfo>();
  await Promise.all(pulls.map(async (p) => {
    const [reviews, ci] = await Promise.all([gitea<Review[]>(`/pulls/${p.number}/reviews`).catch(() => []), ciState(p.head.sha)]);
    const current = reviews.filter((r) => !r.stale && !r.dismissed);
    pullInfo.set(p.head.ref, {
      number: p.number, title: p.title, url: p.html_url, author: p.user.login, mergeable: p.mergeable, ci, head: p.head.ref,
      approvedBy: [...new Set(current.filter((r) => r.state === 'APPROVED').map((r) => r.user.login))],
      changesRequested: [...new Set(current.filter((r) => r.state === 'REQUEST_CHANGES').map((r) => r.user.login))],
    });
  }));

  const merged: string[] = [];
  const infos = (await Promise.all(branches.filter((b) => b.name !== 'main').map(async (b): Promise<BranchInfo | null> => {
    const cmp = await gitea<Compare>(`/compare/main...${encodeURIComponent(b.name)}`).catch(() => null);
    if (!cmp || cmp.total_commits === 0) {
      merged.push(b.name);
      return null;
    }
    const files = cmp.commits.flatMap((c) => (c.files ?? []).map((f) => f.filename));
    return {
      name: b.name, ahead: cmp.total_commits, sha: b.commit.id, updated: b.commit.timestamp, author: b.commit.author.name,
      message: b.commit.message.split('\n')[0]!, ci: await ciState(b.commit.id), ...classify(files),
      pr: pullInfo.get(b.name) ?? null,
    };
  }))).filter((b): b is BranchInfo => b !== null);

  infos.sort((a, b) => b.updated.localeCompare(a.updated));
  return { branches: infos, merged: merged.sort(), pulls: [...pullInfo.values()] };
}

export interface Local {
  branch: string;
  files: { status: string; path: string }[];
  unpushed: { branch: string; commits: number }[];
  worktrees: { path: string; branch: string }[];
}

/** Рабочая копия на стенде: текущая ветка, незакоммиченные файлы, незапушенные коммиты. */
export function localState(): Local {
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'safe.directory=*', '-C', WORKTREE, ...args], {
      encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    if (r.status !== 0) throw new Error(r.stderr.trim() || `git ${args[0]}: код ${r.status}`);
    return r.stdout;
  };
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
  const files = git('status', '--porcelain=v1', '-uall')
    .split('\n').filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  const unpushed = git('for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n').filter(Boolean)
    .map((b) => ({ branch: b, commits: Number(git('rev-list', '--count', b, '--not', '--remotes').trim()) }))
    .filter((b) => b.commits > 0);
  const worktrees: Local['worktrees'] = [];
  let path = '';
  for (const l of git('worktree', 'list', '--porcelain').split('\n')) {
    if (l.startsWith('worktree ')) path = l.slice(9);
    if (l.startsWith('branch ')) worktrees.push({ path, branch: l.slice(7).replace('refs/heads/', '') });
  }
  return { branch, files, unpushed, worktrees: worktrees.slice(1) };
}

// ---------- действия владельца -----------------------------------------------------------


// ---------- для каталога, страниц тула и источника, платформы ----------------------------

const DEPLOYER_URL = process.env.DEPLOYER_URL ?? 'http://deployer:8080';

async function gatewayGet<T>(path: string): Promise<T> {
  const res = await fetch(`${GATEWAY_URL}${path}`, { headers: { Authorization: `Bearer ${PORTAL_TOKEN}` }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`гейтвей ${path}: ${res.status}`);
  return (await res.json()) as T;
}

/** Что умеет тул — он сам говорит (GET /_meta по сети тулов). Описание, не данные. */
export interface ToolMeta {
  name: string; instance: string; title: string; description: string; owner: string; ui: string[];
  sources: string[]; writes: string[]; actions: { name: string; description: string }[];
}
export async function toolMeta(instance: string): Promise<ToolMeta | null> {
  return fetch(`http://tool-${instance}:3000/_meta`, { signal: AbortSignal.timeout(2000) })
    .then((r) => (r.ok ? (r.json() as Promise<ToolMeta>) : null), () => null);
}

export interface Registry {
  loaded_at: string; reload_error: string | null;
  sources: Record<string, {
    title: string; owner: string; approved_by: string; approved_at: string;
    /** Кому хранитель данных открыл источник и его чувствительные поля (шаги Б4 и Б5). */
    allowed_groups?: string[];
    field_groups?: Partial<Record<string, string[]>>;
    datasets: Record<string, {
      description: string; fields: Record<string, string>;
      row_filter?: { field: string; by_group: Record<string, (string | number)[]>; unrestricted_groups: string[] };
    }>;
  }>;
  writes: Record<string, {
    title: string; owner: string; approved_by: string; approved_at: string; source: string; confirm: boolean;
    params: Record<string, { type: string; values?: string[]; required: boolean; description?: string }>;
  }>;
}
export const registry = () => gatewayGet<Registry>('/v1/registry');

export interface Activity {
  calls: number; denied: number;
  people: { actor: string; calls: number; via_agent: number; last_at: string }[];
  writes: { at: string; actor: string; operation: string; write: string; agent_in_chain: boolean; reason: string | null }[];
  denials: { at: string; actor: string; operation: string; reason: string | null }[];
}
export const activity = (tool: string, days = 30) => gatewayGet<Activity>(`/v1/admin/tools/${encodeURIComponent(tool)}/activity?days=${days}`);

export interface Platform {
  registry: { loaded_at: string; reload_error: string | null; sources: number; writes: number };
  connectors: { source: string; title: string; ok: boolean; ms: number; token: boolean }[];
  reaper: { last_sweep_at: string | null };
  directory: { loaded_at: string; error: string | null; people: number; groups: number };
  tools: { active: number; previews: number; expiring: number; idle: number };
}
export const platform = () => gatewayGet<Platform>('/v1/admin/platform');

export interface Deploy { sha: string; branch: string; state: string; started_at?: string; finished_at?: string; log?: string }
export async function deployerHealth(): Promise<boolean> {
  return fetch(`${DEPLOYER_URL}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
}
export async function recentDeploys(): Promise<Deploy[]> {
  const r = await fetch(`${DEPLOYER_URL}/deploys`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`деплоер: ${r.status}`);
  return ((await r.json()) as { deploys: Deploy[] }).deploys;
}
export async function deployOf(sha: string): Promise<Deploy | null> {
  return fetch(`${DEPLOYER_URL}/deploys/${sha}`, { signal: AbortSignal.timeout(3000) }).then((r) => (r.ok ? (r.json() as Promise<Deploy>) : null), () => null);
}
export async function mainHead(): Promise<string> {
  return (await gitea<{ commit: { id: string } }>('/branches/main')).commit.id;
}

export interface CiRun { run_number: number; status: string; head_branch: string; head_sha: string; display_title: string; updated_at?: string }
export async function recentRuns(): Promise<CiRun[]> {
  return (await gitea<{ workflow_runs: CiRun[] }>('/actions/tasks?limit=8')).workflow_runs.slice(0, 8);
}

// ---------- входящие человека (сервис уведомлений) --------------------------------------------

export interface Message {
  id: string; at: string; from: string; event: string; subject: string; text: string; link: string | null; note: string | null; read: boolean;
}
async function notifier<T>(path: string, method = 'GET'): Promise<T> {
  const res = await fetch(`${NOTIFIER_URL}${path}`, { method, headers: { Authorization: `Bearer ${NOTIFY_TOKEN}` }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`уведомления: ${res.status}`);
  return (await res.json()) as T;
}
export const inbox = (actor: string) => notifier<{ unread: number; messages: Message[] }>(`/inbox?to=${encodeURIComponent(actor)}`);
export const notifierHealth = () => notifier<{ ok: boolean; messages: number }>('/healthz').catch(() => null);
export const markRead = (actor: string) => notifier<{ read: number }>(`/inbox?to=${encodeURIComponent(actor)}`, 'POST');

// ---------- метрики (шаг А5) -------------------------------------------------------------------

export interface Metrics {
  scope?: string;
  lives: { name: string; owner: string; born_at: string; ended_at: string | null; end_reason: string | null; sources: string[]; writes: string[] }[];
  firsts: { tool: string; first_preview: string | null; first_prod: string | null }[];
  weekly: { week: string; people: number; person_days: number; calls: number; via_agent: number; writes: number; tools: number }[];
  tools: { tool: string; people: number; person_days: number; calls: number; writes: number; last_at: string }[];
  sources: { source: string; title: string; reads: number; writes: number; people: number; tools_used: number; tools_declared: number }[];
  people: { actor: string; tools: number; calls: number; writes: number; person_days: number; last_at: string }[];
  denials: { tool: string; reason: string | null; calls: number; people: number; last_at: string }[];
}
/** Метрики считает гейтвей от лица человека: он видит свои тулы, администратор — все. */
export async function metrics(identity?: string | null): Promise<Metrics> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/metrics`, {
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, ...(identity ? { 'X-Sandbox-Identity': identity } : {}) },
  });
  if (!res.ok) throw new Error(`гейтвей: ${res.status}`);
  return (await res.json()) as Metrics;
}

/**
 * Начало работы над тулом: отметка scaffold_tool в tool.yaml, а у тулов старше неё — первый коммит tool.yaml в main
 * (это уже конец работы, а не начало — поэтому помечаем, откуда цифра).
 */
export async function startsOf(tools: string[], main: Map<string, Manifest>): Promise<Map<string, { at: string; exact: boolean }>> {
  const out = new Map<string, { at: string; exact: boolean }>();
  await Promise.all(tools.map(async (t) => {
    const stamp = main.get(t)?.started_at;
    if (stamp && !Number.isNaN(Date.parse(stamp))) return void out.set(t, { at: stamp, exact: true });
    const commits = await gitea<{ commit: { author: { date: string } } }[]>(
      `/commits?sha=main&path=${encodeURIComponent(`tools/${t}/tool.yaml`)}&limit=50&stat=false&files=false&verification=false`,
    ).catch(() => []);
    const first = commits.at(-1)?.commit.author.date;
    if (first) out.set(t, { at: new Date(first).toISOString(), exact: false });
  }));
  return out;
}

// ---------- личные ключи MCP (шаг Б2) ------------------------------------------------------------

export interface McpKey {
  prefix: string; name: string; owner: string; created_at: string; created_by: string; expires_at: string;
  last_used_at: string | null; last_agent: string | null; last_ip: string | null;
  revoked_at: string | null; revoked_by: string | null; revoke_reason: string | null;
}

/**
 * Кабинет ходит в сервис личности от имени самого человека: пересылаем его куку входа, своих прав у главной нет.
 * Выпустить и отозвать ключ может только он сам (или администратор песочницы — это проверяет identity).
 */
async function asPersonFetch<T>(cookie: string, path: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${IDENTITY_URL}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `сервис личности: ${res.status}`);
  return data;
}

export const keysOf = (cookie: string, owner: string) =>
  asPersonFetch<{ owner: string; keys: McpKey[] }>(cookie, `/keys?owner=${encodeURIComponent(owner)}`);
export const revokeAllKeys = (cookie: string, owner: string) =>
  asPersonFetch<{ revoked: number }>(cookie, `/keys/all?owner=${encodeURIComponent(owner)}&reason=admin`, { method: 'DELETE' });
export const myKeys = (cookie: string) => asPersonFetch<{ owner: string; keys: McpKey[]; grace_hours: number }>(cookie, '/keys');
export const issueMcpKey = (cookie: string, name: string, replace?: string) =>
  asPersonFetch<McpKey & { key: string; replaced: string | null; grace_hours: number }>(cookie, '/keys', { method: 'POST', body: { name, replace } });
export const revokeMcpKey = (cookie: string, prefix: string) =>
  asPersonFetch<{ revoked: string }>(cookie, `/keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' });

// ---------- группы песочницы (шаг Б3) ------------------------------------------------------------

export interface GroupMember { login: string; added_at: string; added_by: string; expires_at: string | null }
export interface Group { name: string; title: string; created_at: string; created_by: string; members: GroupMember[] }
export interface JournalRow { at: string; actor: string; operation: string; allowed: boolean; reason: string | null }

export const groups = () => gatewayGet<{ groups: Group[] }>('/v1/admin/groups').then((r) => r.groups);
export const groupsOf = (login: string) => gatewayGet<{ groups: string[] }>(`/v1/admin/groups/of/${encodeURIComponent(login)}`).then((r) => r.groups);
export const journal = () => gatewayGet<{ journal: JournalRow[] }>('/v1/admin/groups-journal').then((r) => r.journal);

/** Изменения групп идут в гейтвей от имени человека: он же проверяет, что тот администратор песочницы. */
async function asAdmin(identity: string, path: string, method: string, body?: unknown): Promise<void> {
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, 'X-Sandbox-Identity': identity, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? `гейтвей: ${res.status}`);
}

export const createGroup = (identity: string, name: string, title: string) => asAdmin(identity, '/v1/admin/groups', 'POST', { name, title });
export const deleteGroup = (identity: string, name: string) => asAdmin(identity, `/v1/admin/groups/${encodeURIComponent(name)}`, 'DELETE');
export const addMember = (identity: string, group: string, login: string, days: string) =>
  asAdmin(identity, `/v1/admin/groups/${encodeURIComponent(group)}/members`, 'POST', { login, days: days || null });
export const removeMember = (identity: string, group: string, login: string) =>
  asAdmin(identity, `/v1/admin/groups/${encodeURIComponent(group)}/members/${encodeURIComponent(login)}`, 'DELETE');

// ---------- доступ к тулу (шаг Б4) ---------------------------------------------------------------

export interface ToolAccess { tool: string; groups: string[]; people: string[]; agents: boolean; updated_at: string | null; updated_by: string | null }

export interface AccessRequest {
  id: number; tool: string; login: string; note: string | null;
  created_at: string; status: 'pending' | 'granted' | 'denied'; decided_by: string | null; decided_at: string | null;
}

export const toolRequests = (tool: string) =>
  gatewayGet<{ requests: AccessRequest[] }>(`/v1/admin/tools/${encodeURIComponent(tool)}/access-requests`).then((r) => r.requests);
export const myAccessRequests = (login: string) =>
  gatewayGet<{ requests: AccessRequest[] }>(`/v1/admin/access-requests/mine?login=${encodeURIComponent(login)}`).then((r) => r.requests);

/** Решение владельца по заявке и письмо просителю: доступ даётся одной кнопкой. */
export async function decideAccessRequest(identity: string, tool: string, id: number, decision: 'granted' | 'denied'): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools/${encodeURIComponent(tool)}/access-requests/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, 'X-Sandbox-Identity': identity, 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  const data = (await res.json().catch(() => ({}))) as AccessRequest & { message?: string };
  if (!res.ok) throw new Error(data.message ?? `гейтвей: ${res.status}`);
  await fetch(`${NOTIFIER_URL}/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NOTIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: [data.login], event: 'access.decided', key: `access-decided:${data.id}`,
      subject: decision === 'granted' ? `Вам открыли тул ${tool}` : `В доступе к тулу ${tool} отказано`,
      text: decision === 'granted'
        ? 'Откройте тул — он уже доступен. Если подключаете агентом, перезапускать ничего не нужно.'
        : 'Решение принял владелец тула. Если доступ всё-таки нужен, напишите ему напрямую.',
      link: `http://${DOMAIN}:${PUBLIC_PORT}/tools/${encodeURIComponent(tool)}`,
    }),
  }).catch(() => undefined);
  return decision === 'granted' ? `${data.login} получил доступ к ${tool}` : `Заявка ${data.login} отклонена`;
}

export const toolAccess = (tool: string) => gatewayGet<ToolAccess>(`/v1/admin/tools/${encodeURIComponent(tool)}/access`);

/** Кому из списка тул доступен: каталог показывает человеку только его тулы. */
export async function allowedTools(login: string, groups: string[], instances: string[]): Promise<Record<string, boolean>> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/access-check`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, groups, instances }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`гейтвей: доступ ${res.status}`);
  return ((await res.json()) as { allowed: Record<string, boolean> }).allowed;
}

export async function setToolAccess(identity: string, tool: string, patch: { groups?: string[]; people?: string[]; agents?: boolean }): Promise<ToolAccess> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools/${encodeURIComponent(tool)}/access`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, 'X-Sandbox-Identity': identity, 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = (await res.json().catch(() => ({}))) as ToolAccess & { message?: string };
  if (!res.ok) throw new Error(data.message ?? `гейтвей: ${res.status}`);
  return data;
}

/** Заявка на доступ: гейтвей говорит, кому её отправить, уведомление уходит владельцу. */
export async function requestAccess(identity: string, tool: string, note: string): Promise<string> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools/${encodeURIComponent(tool)}/access-request`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, 'X-Sandbox-Identity': identity, 'Content-Type': 'application/json' },
    body: JSON.stringify({ note }),
  });
  const data = (await res.json().catch(() => ({}))) as { owner: string; actor: string; message?: string };
  if (!res.ok) throw new Error(data.message ?? `гейтвей: ${res.status}`);
  const sent = await fetch(`${NOTIFIER_URL}/notify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${NOTIFY_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: [data.owner], event: 'access.request', key: `access:${tool}:${data.actor}:${new Date().toISOString().slice(0, 10)}`,
      subject: `${data.actor} просит доступ к тулу ${tool}`,
      text: `${note || 'Без пояснения.'}\nОткрыть доступ — на странице тула, блок «Доступ»: добавьте его группу или его самого.`,
      link: `http://${DOMAIN}:${PUBLIC_PORT}/tools/${encodeURIComponent(tool)}`,
    }),
  });
  return sent.ok ? `Заявка отправлена владельцу (${data.owner})` : `Заявка записана в аудит, но уведомление не ушло — скажите владельцу (${data.owner}) сами`;
}

// ---------- журнал событий с фильтрами (П3, П4) --------------------------------------------------

export interface EventFilter {
  days: number; tool?: string; actor?: string; source?: string;
  channel?: 'web' | 'mcp'; kind?: 'read' | 'write' | 'access' | 'admin';
  denied?: boolean; people?: boolean; order?: 'asc' | 'desc';
  sort?: 'calls' | 'denied' | 'writes' | 'via_agent' | 'tools' | 'last_at' | 'actor';
  limit: number; offset: number;
}
export interface EventRow {
  id: number; at: string; actor: string; tool: string; source: string | null;
  operation: string; agent_in_chain: boolean; allowed: boolean; reason: string | null; fields: string[] | null;
}
export interface ActorRow {
  actor: string; calls: number; denied: number; writes: number; via_agent: number; tools: number; last_at: string;
}
export interface Events {
  filter: EventFilter; scope: string; rows: EventRow[]; total: number; denied: number; people: number;
  tools: string[]; actors: string[]; sources: string[];
  by_actor?: ActorRow[];
}

/** Журнал считает гейтвей от лица человека: он видит свои тулы, администратор — все. */
export async function events(identity: string | undefined, query: URLSearchParams): Promise<Events> {
  const res = await fetch(`${GATEWAY_URL}/v1/admin/events?${query}`, {
    headers: { Authorization: `Bearer ${PORTAL_TOKEN}`, ...(identity ? { 'X-Sandbox-Identity': identity } : {}) },
  });
  if (!res.ok) throw new Error(`гейтвей: журнал ${res.status}`);
  return (await res.json()) as Events;
}
