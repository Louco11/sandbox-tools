import { randomUUID, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ADMINS, loadRegistry, validateManifest, type Registry } from '@sandbox/manifest';
import { REGISTRY_DEMO_PATH, REGISTRY_PATH, config, registry, registryState, setRegistry, type AdminScope } from './config.ts';
import { audit } from './audit.ts';
import { service } from './db.ts';
import { HttpError, badRequest, forbidden, unauthorized } from './errors.ts';
import { parseActor, type CallContext } from './context.ts';
import { createMcpServer } from './mcp.ts';
import { platformState, pruneTools, reaperState, toolActivity } from './platform.ts';
import { ownersOf, resolveName } from './directory.ts';
import { HEADER as IDENTITY_HEADER, identityOf } from './identity.ts';
import { metrics, visibleTools } from './metrics.ts';
import { events, eventsByActor, type EventFilter } from './events.ts';
import { addMember, createGroup, groupJournal, groupsOf, listGroups, removeGroup, removeMember } from './groups.ts';
import { accessOf, canUse, decideRequest, myRequests, pendingRequests, requestAccess, seedAccess, setAccess, toolOf } from './access.ts';
import { runQuery } from './query.ts';
import {
  activePreviews, authenticate, extendTool, issueToken, lifecycleOf, listTools, loadTool, markIdle, markOrphans, registerTool, revokeTool, touchByHuman,
  type ToolRow,
} from './tools.ts';
import { applyWrite, commitWrite, prepareWrite } from './writes.ts';

const app = express();
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const id = randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
});

type Handler = (req: Request, res: Response) => Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/** Контекст вызова тула: токен + живой человек + признак агента. */
async function toolContext(req: Request, res: Response, viaAgent: string | null): Promise<CallContext> {
  let tool;
  let actor;
  let identity = null;
  try {
    tool = await authenticate(req.header('authorization'));
    // Личность, подписанная identity: тул её только пересылает и подделать не может — проверяем подпись и aud.
    identity = await identityOf(req.header(IDENTITY_HEADER), tool.name).catch((e: Error) => {
      throw unauthorized(`личность не принята: ${e.message}`);
    });
    actor = identity?.actor ?? null;
    if (!actor) throw unauthorized('нужна личность: подписанный заголовок X-Sandbox-Identity от сервиса identity');
  } catch (e) {
    // Отказ на входе — тоже вызов, он попадает в аудит.
    await audit({
      requestId: res.locals.requestId as string,
      actor: actor ?? '(unknown)',
      tool: tool?.name ?? '(unauthenticated)',
      operation: `auth ${req.method} ${req.path}`,
      agentInChain: (viaAgent ?? req.header('x-agent')) != null,
      allowed: false,
      reason: (e as Error).message,
    });
    throw e;
  }
  // Группы человека: из личности (IdP) и из песочницы. По ним решаются доступ, поля, строки и права записи.
  const groups = [...new Set([...(identity?.groups ?? []), ...(await groupsOf(actor))])];
  // Круг доступа проверяем и здесь, а не только на входе в Traefik: тул могли позвать изнутри сети.
  const verdict = await canUse(tool.name, { actor, groups, channel: identity?.channel ?? 'web' }, tool.owner);
  if (!verdict.allowed) {
    await audit({
      requestId: res.locals.requestId as string, actor, tool: tool.name, operation: `access ${req.method} ${req.path}`,
      agentInChain: identity?.channel === 'mcp', allowed: false, reason: verdict.reason,
    });
    throw forbidden(verdict.reason);
  }

  const ctx: CallContext = {
    requestId: res.locals.requestId as string,
    tool: tool.name,
    manifest: tool.manifest,
    actor,
    groups,
    // Канал решает личность, а не тул: web — человек в браузере, mcp — человек в хосте агента.
    agent: identity?.channel === 'web' ? null : viaAgent ?? req.header('x-agent') ?? 'mcp-client',
  };
  res.locals.toolRow = tool;

  // Использование человеком продлевает срок жизни (в пределах лимита). Агент срок не двигает.
  if (ctx.agent === null) {
    const revived = await touchByHuman(tool).catch((e: Error) => {
      console.error(JSON.stringify({ type: 'error', requestId: ctx.requestId, error: `touch: ${e.message}` }));
      return false;
    });
    if (revived) {
      await audit({ requestId: ctx.requestId, actor, tool: tool.name, operation: 'tool.activity', agentInChain: false, allowed: true, reason: 'использование после уведомления о простое — удаление отменено' });
    }
  }
  return ctx;
}

/** Продлить или удалить тул из его интерфейса может только владелец, сам, без агента в цепочке. */
function ownerRefusal(owner: string, actor: string): string {
  const o = ownersOf(owner);
  return o.note
    ? `это решение владельца тула (${owner}): ${o.note} — а не ${actor}`
    : `это решение владельца тула (${owner}), а не ${actor}`;
}

/**
 * Главная действует от имени человека (X-Actor): продлить и удалить можно, только если он решает за владельца.
 * Администратор стенда (make extend / revoke) и деплоер (превью удалённых веток) проверку не проходят — у них своя роль.
 */
async function portalActor(req: Request): Promise<string | null> {
  return (await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null))?.actor ?? null;
}

async function checkPortalOwner(req: Request, role: string, name: string, operation: string, requestId: string): Promise<string> {
  const actor = await portalActor(req);
  if (role !== 'portal') return actor ?? role;
  const tool = await loadTool(name);
  if (!tool) throw new HttpError(404, 'not_found', `тул ${name} не зарегистрирован`);
  const reason = !actor ? 'нужен X-Actor — кто решает' : ownersOf(tool.owner).logins.includes(actor) ? null : ownerRefusal(tool.owner, actor);
  if (reason) {
    await audit({ requestId, actor: actor ?? 'portal', tool: name, operation, agentInChain: false, allowed: false, reason });
    throw forbidden(reason);
  }
  return actor!;
}

async function ownerContext(req: Request, res: Response, operation: string): Promise<{ ctx: CallContext; tool: ToolRow }> {
  const ctx = await toolContext(req, res, null);
  const tool = res.locals.toolRow as ToolRow;
  const reason = ctx.agent !== null
    ? 'продлевать и удалять тул может только человек; у агента нет такого права'
    : !ownersOf(tool.owner).logins.includes(ctx.actor)
      ? ownerRefusal(tool.owner, ctx.actor)
      : null;
  if (reason) {
    await audit({ requestId: ctx.requestId, actor: ctx.actor, tool: tool.name, operation, agentInChain: ctx.agent !== null, allowed: false, reason });
    throw forbidden(reason);
  }
  return { ctx, tool };
}

app.get('/healthz', route(async (_req, res) => {
  await service.query('SELECT 1');
  res.json({ ok: true });
}));

// Публичная часть реестра: что одобрено и с какой чувствительностью. Подключения и адреса коннекторов не раскрываются.
app.get('/v1/registry', (_req, res) => {
  res.json({
    loaded_at: registryState.loaded_at,
    reload_error: registryState.error,
    policy: registry.policy,
    sources: Object.fromEntries(
      Object.entries(registry.sources).map(([id, { connector: _, ...s }]) => [id, s]),
    ),
    writes: registry.writes,
  });
});

/**
 * Реестр без рестарта: файл перечитывается при изменении. Новый применяется, только если годен целиком — схема и
 * токены коннекторов в окружении гейтвея. Иначе работает прежний, ошибка — в /v1/registry.
 */
function registryProblems(r: Registry): string[] {
  const envs = [...new Set(Object.values(r.sources).map((s) => s.connector.token_env))];
  return envs.filter((e) => !process.env[e]).map((e) => `у гейтвея нет токена коннектора ${e} — нужен перезапуск с ним`);
}

let registryMtime = statSync(REGISTRY_PATH).mtimeMs;
setInterval(() => {
  let mtime: number;
  try {
    mtime = statSync(REGISTRY_PATH).mtimeMs;
  } catch {
    return;
  }
  if (mtime === registryMtime) return;
  registryMtime = mtime;
  try {
    const next = loadRegistry(REGISTRY_PATH, REGISTRY_DEMO_PATH);
    const problems = registryProblems(next);
    if (problems.length) throw new Error(problems.join('; '));
    setRegistry(next);
    console.log(JSON.stringify({ type: 'registry_reloaded', sources: Object.keys(next.sources), writes: Object.keys(next.writes) }));
  } catch (e) {
    registryState.error = (e as Error).message;
    console.error(JSON.stringify({ type: 'registry_rejected', error: registryState.error }));
  }
}, Number(process.env.REGISTRY_POLL_MS ?? 3000));

const PREVIEW_TTL_DAYS = 7;
// Живых превью на стенде не больше этого: каждое — контейнер, образ и токен. Сверх лимита — отказ со списком,
// что пора убрать (удалить ветку). Передеплой уже существующего превью лимит не расходует.
const MAX_PREVIEWS = Number(process.env.GATEWAY_MAX_PREVIEWS ?? 10);

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Сервисная учётка платформы с нужным правом. Возвращает имя роли — оно идёт в аудит, если нет X-Actor. */
function requireAdmin(req: Request, ...anyOf: AdminScope[]): string {
  const given = req.header('authorization') ?? '';
  const role = config.adminRoles.find((r) => same(given, `Bearer ${r.token}`));
  if (!role) throw unauthorized('нужен сервисный токен платформы');
  if (!anyOf.some((s) => role.scopes.includes(s))) throw forbidden(`роли ${role.role} не разрешено ${anyOf.join(' / ')}`);
  return role.role;
}

function branchSlug(branch: string): string {
  if (branch.startsWith('preview/')) return 'preview';
  return branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'branch';
}

// Допуск тула в контур. Вызывает только CI при деплое.
// preview: { branch } — отдельный инстанс <tool>--<ветка> с коротким TTL.
app.post('/v1/admin/tools', route(async (req, res) => {
  const role = requireAdmin(req, 'tools.register');
  const requestId = res.locals.requestId as string;
  const actor = parseActor(req.header('x-actor')) ?? role;
  const result = validateManifest(req.body?.manifest, registry);
  const name = typeof req.body?.manifest?.name === 'string' ? req.body.manifest.name : '(unknown)';
  const branch: unknown = req.body?.preview?.branch;

  if (!result.ok) {
    await audit({ requestId, actor, tool: name, operation: 'tool.register', agentInChain: false, allowed: false, reason: 'манифест невалиден' });
    res.status(422).json({ error: 'invalid_manifest', errors: result.errors });
    return;
  }
  const m = result.manifest;
  const instance = typeof branch === 'string' ? `${m.name}--${branchSlug(branch)}` : m.name;
  // Манифест задаёт круг доступа только при первом допуске; дальше главнее живой, его меняет человек.
  const accessWarning = await seedAccess(m.name, m.access, actor);
  const ttl = typeof branch === 'string' ? Math.min(m.ttl_days, PREVIEW_TTL_DAYS) : m.ttl_days;
  if (typeof branch === 'string') {
    const others = (await activePreviews()).filter((p) => p.name !== instance);
    if (others.length >= MAX_PREVIEWS) {
      const reason = `лимит превью на стенде: ${MAX_PREVIEWS}. Живые: ${others.map((p) => p.name).join(', ')}. ` +
        'Удалите смерженные и брошенные ветки — их превью уберутся сами';
      await audit({ requestId, actor, tool: instance, operation: 'tool.register', agentInChain: false, allowed: false, reason });
      res.status(409).json({ error: 'preview_limit', message: reason, previews: others });
      return;
    }
  }
  try {
    const { secret, expiresAt } = await registerTool(m, instance, ttl, typeof branch === 'string');
    await audit({ requestId, actor, tool: instance, operation: 'tool.register', agentInChain: false, allowed: true });
    res.status(201).json({
      tool: instance, client_secret: secret, expires_at: expiresAt,
      scope: { sources: m.sources, writes: m.writes },
      ...(accessWarning ? { access_warning: accessWarning } : {}),
    });
  } catch (e) {
    await audit({ requestId, actor, tool: instance, operation: 'tool.register', agentInChain: false, allowed: false, reason: (e as Error).message });
    throw e;
  }
}));

app.get('/v1/admin/tools', route(async (req, res) => {
  requireAdmin(req, 'tools.list');
  const tools = (await listTools()).map((t) => {
    const o = ownersOf(t.owner);
    return { ...t, owners: o.logins, owner_kind: o.kind, owner_note: o.note };
  });
  res.json({ tools });
}));

// ---------- доступ к тулу (шаг Б4): решает владелец, ограничивает источник -----------------------------------

app.get('/v1/admin/tools/:name/access', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  const name = String(req.params.name);
  const access = await accessOf(name);
  res.json(access ?? { tool: toolOf(name), groups: [], people: [], agents: true, updated_at: null, updated_by: null });
}));

/** Кого пускать — решает владелец тула или администратор песочницы. Меняется без передеплоя. */
app.put('/v1/admin/tools/:name/access', route(async (req, res) => {
  requireAdmin(req, 'groups.write');
  const requestId = res.locals.requestId as string;
  const name = toolOf(String(req.params.name));
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  const tool = await loadTool(name);
  if (!tool) throw new HttpError(404, 'not_found', `тул ${name} не зарегистрирован`);
  const actor = identity?.actor ?? null;
  const groupsOfActor = actor ? [...identity!.groups, ...(await groupsOf(actor))] : [];
  const may = actor && (ownersOf(tool.owner).logins.includes(actor) || groupsOfActor.includes(ADMINS));
  if (!may) {
    const reason = actor ? `доступом к ${name} распоряжается владелец (${tool.owner}) или администратор песочницы` : 'нужна личность человека';
    await audit({ requestId, actor: actor ?? '(unknown)', tool: name, operation: 'access.set', agentInChain: false, allowed: false, reason });
    throw forbidden(reason);
  }

  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : undefined);
  const groups = list(req.body?.groups);
  // Источник ограничивает, кому его данные видны: шире его allowed_groups тул открыть нельзя.
  for (const source of tool.manifest.sources) {
    const allowed = registry.sources[source]?.allowed_groups ?? [];
    const extra = allowed.length ? (groups ?? []).filter((g) => !allowed.includes(g)) : [];
    if (extra.length) {
      const reason = `источник «${source}» открыт только группам ${allowed.join(', ')}; ${extra.join(', ')} туда не входят — это решает хранитель данных в реестре`;
      await audit({ requestId, actor: actor!, tool: name, operation: 'access.set', agentInChain: false, allowed: false, reason });
      throw forbidden(reason);
    }
  }
  const access = await setAccess(name, { groups, people: list(req.body?.people), agents: typeof req.body?.agents === 'boolean' ? req.body.agents : undefined }, actor!);
  await audit({
    requestId, actor: actor!, tool: name, operation: 'access.set', agentInChain: false, allowed: true,
    reason: `группы: ${access.groups.join(', ') || 'нет'}${access.people.length ? `; люди: ${access.people.join(', ')}` : ''}; агенты: ${access.agents ? 'да' : 'нет'}`,
  });
  res.json(access);
}));

/** Может ли человек открыть этот инстанс — для ForwardAuth: отказ должен случиться до тула. */
app.get('/v1/admin/access-check', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  const instance = String(req.query.instance ?? '');
  const actor = parseActor(String(req.query.login ?? ''));
  if (!instance || !actor) throw badRequest('нужны instance и login');
  const tool = await loadTool(instance);
  if (!tool) {
    res.json({ allowed: false, reason: `тул ${instance} не зарегистрирован или уже удалён`, owner: null });
    return;
  }
  const groups = String(req.query.groups ?? '').split(',').map((g) => g.trim()).filter(Boolean);
  const channel = req.query.channel === 'mcp' ? 'mcp' : 'web';
  res.json(await canUse(instance, { actor, groups, channel }, tool.owner));
}));

/** Что из списка доступно человеку — для каталога на главной: показываем только его тулы. */
app.post('/v1/admin/access-check', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  const actor = parseActor(String(req.body?.login ?? ''));
  const instances = Array.isArray(req.body?.instances) ? req.body.instances.map(String).slice(0, 200) : [];
  if (!actor) throw badRequest('нужен login');
  const groups = Array.isArray(req.body?.groups) ? req.body.groups.map(String) : [];
  const channel = req.body?.channel === 'mcp' ? 'mcp' : 'web';
  const out: Record<string, boolean> = {};
  for (const instance of instances) {
    const tool = await loadTool(instance);
    out[instance] = tool ? (await canUse(instance, { actor, groups, channel }, tool.owner)).allowed : false;
  }
  res.json({ login: actor, allowed: out });
}));

/** Заявка на доступ: сохраняем её как объект, чтобы владелец закрыл одной кнопкой, и говорим, кому написать. */
app.post('/v1/admin/tools/:name/access-request', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  const name = toolOf(String(req.params.name));
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  if (!identity) throw forbidden('нужна личность человека');
  const tool = await loadTool(name);
  if (!tool) throw new HttpError(404, 'not_found', `тул ${name} не зарегистрирован`);
  const note = String(req.body?.note ?? '').slice(0, 300);
  const request = await requestAccess(name, identity.actor, note);
  await audit({
    requestId: res.locals.requestId as string, actor: identity.actor, tool: name, operation: 'access.request',
    agentInChain: false, allowed: true, reason: note ? `просит доступ: ${note}` : 'просит доступ',
  });
  res.json({ tool: name, owner: tool.owner, owners: ownersOf(tool.owner).logins, actor: identity.actor, note, request });
}));

/** Заявки, ждущие решения владельца. */
app.get('/v1/admin/tools/:name/access-requests', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  res.json({ requests: await pendingRequests(String(req.params.name)) });
}));

/** Мои заявки — чтобы не просить дважды и увидеть ответ. */
app.get('/v1/admin/access-requests/mine', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  const login = parseActor(String(req.query.login ?? ''));
  if (!login) throw badRequest('нужен login');
  res.json({ requests: await myRequests(login) });
}));

/** Решение владельца: «дать доступ» одной кнопкой добавляет человека в круг тула. */
app.post('/v1/admin/tools/:name/access-requests/:id', route(async (req, res) => {
  requireAdmin(req, 'groups.write');
  const requestId = res.locals.requestId as string;
  const name = toolOf(String(req.params.name));
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  const tool = await loadTool(name);
  if (!tool) throw new HttpError(404, 'not_found', `тул ${name} не зарегистрирован`);
  const actor = identity?.actor ?? null;
  const groupsOfActor = actor ? [...identity!.groups, ...(await groupsOf(actor))] : [];
  if (!actor || !(ownersOf(tool.owner).logins.includes(actor) || groupsOfActor.includes(ADMINS))) {
    const reason = `заявки к ${name} закрывает владелец (${tool.owner}) или администратор песочницы`;
    await audit({ requestId, actor: actor ?? '(unknown)', tool: name, operation: 'access.decide', agentInChain: false, allowed: false, reason });
    throw forbidden(reason);
  }
  const decision = req.body?.decision === 'granted' ? 'granted' : 'denied';
  const request = await decideRequest(Number(req.params.id), decision, actor);
  if (!request) throw new HttpError(404, 'not_found', 'заявка не найдена или уже закрыта');
  await audit({
    requestId, actor, tool: name, operation: 'access.decide', agentInChain: false, allowed: true,
    reason: `${decision === 'granted' ? 'дал доступ' : 'отказал'}: ${request.login}`,
  });
  res.json(request);
}));

// ---------- группы песочницы (шаг Б3): состав задаёт администратор, решение о правах — здесь ----------------

/** Кто администратор песочницы: группа из IdP или группа песочницы с тем же именем. */
async function requireSandboxAdmin(req: Request, operation: string, requestId: string): Promise<string> {
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  const actor = identity?.actor ?? null;
  const groups = actor ? [...identity!.groups, ...(await groupsOf(actor))] : [];
  if (!actor || !groups.includes(ADMINS)) {
    const reason = actor ? `${actor} не в группе ${ADMINS}` : 'нужна личность человека (X-Sandbox-Identity)';
    await audit({ requestId, actor: actor ?? '(unknown)', tool: 'groups', operation, agentInChain: false, allowed: false, reason });
    throw forbidden(reason);
  }
  return actor;
}

app.get('/v1/admin/groups', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  res.json({ groups: await listGroups() });
}));

// Группы человека — их сервис личности кладёт в личность вместе с группами IdP.
app.get('/v1/admin/groups/of/:login', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  res.json({ login: String(req.params.login), groups: await groupsOf(String(req.params.login)) });
}));

app.post('/v1/admin/groups', route(async (req, res) => {
  requireAdmin(req, 'groups.write');
  const requestId = res.locals.requestId as string;
  const actor = await requireSandboxAdmin(req, 'group.create', requestId);
  const name = String(req.body?.name ?? '').trim();
  const group = await createGroup({ name, title: String(req.body?.title ?? '').trim(), by: actor });
  await audit({ requestId, actor, tool: 'groups', operation: 'group.create', agentInChain: false, allowed: true, reason: `группа ${name}` });
  res.json(group);
}));

app.delete('/v1/admin/groups/:name', route(async (req, res) => {
  requireAdmin(req, 'groups.write');
  const requestId = res.locals.requestId as string;
  const actor = await requireSandboxAdmin(req, 'group.delete', requestId);
  const name = String(req.params.name);
  const ok = await removeGroup(name);
  await audit({ requestId, actor, tool: 'groups', operation: 'group.delete', agentInChain: false, allowed: ok, reason: ok ? `группа ${name}` : `группы ${name} нет` });
  res.status(ok ? 200 : 404).json(ok ? { deleted: name } : { error: 'not_found', message: `группы ${name} нет` });
}));

app.post('/v1/admin/groups/:name/members', route(async (req, res) => {
  requireAdmin(req, 'groups.write');
  const requestId = res.locals.requestId as string;
  const actor = await requireSandboxAdmin(req, 'group.member_add', requestId);
  const group = String(req.params.name);
  const login = parseActor(String(req.body?.login ?? ''));
  if (!login) throw badRequest('нужен login человека');
  const days = req.body?.days === undefined || req.body?.days === null || req.body?.days === '' ? null : Number(req.body.days);
  if (days !== null && (!Number.isInteger(days) || days <= 0)) throw badRequest('days — целое положительное или пусто (бессрочно)');
  const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
  await addMember({ group, login, by: actor, expiresAt });
  await audit({
    requestId, actor, tool: 'groups', operation: 'group.member_add', agentInChain: false, allowed: true,
    reason: `${login} в группу ${group}${expiresAt ? ` до ${expiresAt.toISOString().slice(0, 10)}` : ''}`,
  });
  res.json({ group, login, expires_at: expiresAt });
}));

app.delete('/v1/admin/groups/:name/members/:login', route(async (req, res) => {
  requireAdmin(req, 'groups.write');
  const requestId = res.locals.requestId as string;
  const actor = await requireSandboxAdmin(req, 'group.member_remove', requestId);
  const group = String(req.params.name);
  const login = String(req.params.login);
  const ok = await removeMember(group, login);
  await audit({ requestId, actor, tool: 'groups', operation: 'group.member_remove', agentInChain: false, allowed: ok, reason: `${login} из группы ${group}` });
  res.status(ok ? 200 : 404).json(ok ? { group, login } : { error: 'not_found', message: 'такого участника нет' });
}));

app.get('/v1/admin/groups-journal', route(async (req, res) => {
  requireAdmin(req, 'groups.read');
  res.json({ journal: await groupJournal(Number(req.query.limit ?? 40)) });
}));

// Справочник: логин, группа или e-mail автора коммита → кому доставить уведомление и кто решает за владельца.
app.get('/v1/admin/directory/resolve', route(async (req, res) => {
  requireAdmin(req, 'directory.read');
  const name = String(req.query.name ?? '').trim();
  if (!name || name.length > 200) throw badRequest('нужно name — логин, группа или e-mail');
  res.json({ name, ...resolveName(name) });
}));

app.post('/v1/admin/tools/:name/extend', route(async (req, res) => {
  const role = requireAdmin(req, 'tools.extend');
  const days = Number(req.body?.days);
  if (!Number.isInteger(days) || days <= 0) throw badRequest('нужно days — целое положительное');
  const name = String(req.params.name);
  const actor = await checkPortalOwner(req, role, name, 'tool.extend', res.locals.requestId as string);
  const expiresAt = await extendTool(name, days);
  await audit({ requestId: res.locals.requestId as string, actor, tool: name, operation: 'tool.extend', agentInChain: false, allowed: true, reason: `до ${expiresAt.toISOString()}` });
  res.json({ tool: name, expires_at: expiresAt });
}));

app.post('/v1/admin/tools/:name/revoke', route(async (req, res) => {
  const name = String(req.params.name);
  // Превью (<тул>--<ветка>) может отозвать и деплоер — когда ветку удалили. Прод — только человек-админ.
  const role = name.includes('--') ? requireAdmin(req, 'tools.revoke', 'tools.revoke-preview') : requireAdmin(req, 'tools.revoke');
  const actor = await checkPortalOwner(req, role, name, 'tool.revoke', res.locals.requestId as string);
  await revokeTool(name);
  await audit({ requestId: res.locals.requestId as string, actor, tool: name, operation: 'tool.revoke', agentInChain: false, allowed: true, reason: typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : undefined });
  res.json({ tool: name, revoked: true });
}));

// Проверка простоя. Вызывает уборщик на каждом цикле.
app.post('/v1/admin/tools/sweep-idle', route(async (req, res) => {
  requireAdmin(req, 'tools.sweep');
  reaperState.last_sweep_at = new Date();
  const idle = (await markIdle()).map((t) => ({ ...t, reason: 'idle' as const }));
  const orphans = (await markOrphans()).map((t) => ({ ...t, reason: 'orphan' as const }));
  for (const t of [...idle, ...orphans]) {
    await audit({
      requestId: res.locals.requestId as string, actor: 'reaper', tool: t.name, operation: 'tool.idle', agentInChain: false, allowed: true,
      reason: t.reason === 'idle'
        ? `нет вызовов человека ${registry.policy.idle_days} дн.; владелец ${t.owner} уведомлён, удаление ${t.expires_at.toISOString()}`
        : `некому решать за владельца: ${ownersOf(t.owner).note}; удаление ${t.expires_at.toISOString()}`,
    });
  }
  res.json({ idle: [...idle, ...orphans] });
}));

// Уборка истории: строки тулов, отозванных или истёкших больше недели назад. Аудит остаётся. Вызывает уборщик.
app.post('/v1/admin/tools/prune', route(async (req, res) => {
  requireAdmin(req, 'tools.sweep');
  const pruned = await pruneTools();
  for (const name of pruned) {
    await audit({ requestId: res.locals.requestId as string, actor: 'reaper', tool: name, operation: 'tool.prune', agentInChain: false, allowed: true, reason: 'отозван или истёк больше 7 дней назад' });
  }
  res.json({ pruned });
}));

// Активность тула из аудита — для страницы тула на главной.
app.get('/v1/admin/tools/:name/activity', route(async (req, res) => {
  requireAdmin(req, 'tools.activity');
  const name = String(req.params.name);
  // Кто чем пользовался — не публичная информация: показываем тем, кому тул открыт.
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  if (identity) {
    const tool = await loadTool(name);
    const groups = [...identity.groups, ...(await groupsOf(identity.actor))];
    const verdict = tool ? await canUse(name, { actor: identity.actor, groups, channel: 'web' }, tool.owner) : null;
    if (!verdict?.allowed) throw forbidden(verdict?.reason ?? `тул ${name} вам не открыт`);
  }
  res.json(await toolActivity(name, Number(req.query.days ?? 30)));
}));

// Метрики песочницы — для главной: выживаемость, время до превью, использование, спрос на источники. Только агрегаты.
app.get('/v1/admin/metrics', route(async (req, res) => {
  requireAdmin(req, 'platform.read');
  // Метрики считаются от лица человека: он видит свои тулы, администратор песочницы — все.
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  const viewer = identity ? { actor: identity.actor, groups: [...identity.groups, ...(await groupsOf(identity.actor))] } : undefined;
  res.json(await metrics(viewer));
}));

/** События из журнала с фильтрами — для разбора на главной (П3, П4). Человеку видны только его тулы. */
app.get('/v1/admin/events', route(async (req, res) => {
  requireAdmin(req, 'tools.activity');
  const q = req.query as Record<string, string | undefined>;
  const identity = await identityOf(req.header(IDENTITY_HEADER), 'portal').catch(() => null);
  const groups = identity ? [...identity.groups, ...(await groupsOf(identity.actor))] : [];
  // Без личности не видно ничего: журнал — это те же данные, что и тулы, только в разрезе времени.
  const visible = !identity ? [] : groups.includes(ADMINS) ? null : await visibleTools({ actor: identity.actor, groups });

  const num = (v: string | undefined, def: number) => (Number.isFinite(Number(v)) ? Number(v) : def);
  const name = (v: string | undefined) => (v && /^[a-z][a-z0-9-]{0,62}$/.test(v) ? v : undefined);
  // В аудите у чтения в source источник, а у записи — id права (tasks.task:update): фильтр принимает оба.
  const src = (v: string | undefined) => (v && /^[a-z][a-z0-9.:_-]{0,79}$/.test(v) ? v : undefined);
  const filter: EventFilter = {
    days: num(q.days, 14),
    tool: name(q.tool),
    actor: parseActor(q.actor ?? '') ?? undefined,
    source: src(q.source),
    channel: q.channel === 'web' || q.channel === 'mcp' ? q.channel : undefined,
    kind: ['read', 'write', 'access', 'admin'].includes(q.kind ?? '') ? (q.kind as EventFilter['kind']) : undefined,
    denied: q.denied === '1',
    people: q.people === '1',
    order: q.order === 'asc' ? 'asc' : 'desc',
    sort: ['calls', 'denied', 'writes', 'via_agent', 'tools', 'last_at', 'actor'].includes(q.sort ?? '') ? (q.sort as EventFilter['sort']) : undefined,
    limit: Math.min(200, Math.max(1, num(q.limit, 100))),
    offset: Math.max(0, num(q.offset, 0)),
  };
  const found = await events(filter, visible);
  const scope = visible ? 'ваши тулы' : 'все тулы';
  res.json({ filter, scope, ...found, ...(q.by === 'actor' ? { by_actor: await eventsByActor(filter, visible) } : {}) });
}));

// Здоровье платформы — для главной: реестр, коннекторы, уборщик, число тулов.
app.get('/v1/admin/platform', route(async (req, res) => {
  requireAdmin(req, 'platform.read');
  res.json(await platformState());
}));

// Жизненный цикл глазами тула: срок, предел автопродления, простой. Здесь же — что этому человеку разрешено
// записывать (шаг Б5): интерфейс прячет кнопки, которых ему всё равно не дадут.
app.post('/v1/lifecycle', route(async (req, res) => {
  const ctx = await toolContext(req, res, null);
  const tool = await loadTool((res.locals.toolRow as ToolRow).name);
  const writes = tool!.manifest.writes.filter((w) => {
    const groups = tool!.manifest.write_groups[w] ?? [];
    return !groups.length || groups.some((g) => ctx.groups.includes(g));
  });
  res.json({ ...lifecycleOf(tool!), writes, groups: ctx.groups });
}));

app.post('/v1/lifecycle/extend', route(async (req, res) => {
  const { ctx, tool } = await ownerContext(req, res, 'tool.extend');
  const days = req.body?.days === undefined ? tool.manifest.ttl_days : Number(req.body.days);
  if (!Number.isInteger(days) || days <= 0) throw badRequest('days — целое положительное');
  const expiresAt = await extendTool(tool.name, days);
  await audit({ requestId: ctx.requestId, actor: ctx.actor, tool: tool.name, operation: 'tool.extend', agentInChain: false, allowed: true, reason: `владелец из интерфейса, до ${expiresAt.toISOString()}` });
  res.json(lifecycleOf((await loadTool(tool.name))!));
}));

app.post('/v1/lifecycle/revoke', route(async (req, res) => {
  const { ctx, tool } = await ownerContext(req, res, 'tool.revoke');
  await revokeTool(tool.name);
  await audit({ requestId: ctx.requestId, actor: ctx.actor, tool: tool.name, operation: 'tool.revoke', agentInChain: false, allowed: true, reason: 'владелец из интерфейса' });
  res.json({ tool: tool.name, revoked: true });
}));

app.post('/v1/token', route(async (req, res) => {
  const { tool, client_secret } = req.body ?? {};
  if (typeof tool !== 'string' || typeof client_secret !== 'string') throw badRequest('нужны tool и client_secret');
  const base = { requestId: res.locals.requestId as string, actor: 'system', tool, operation: 'token.issue', agentInChain: false };
  try {
    const { token, expiresIn } = await issueToken(tool, client_secret);
    await audit({ ...base, allowed: true });
    res.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn });
  } catch (e) {
    await audit({ ...base, allowed: false, reason: (e as Error).message });
    throw e;
  }
}));

app.post('/v1/sources/:source/query', route(async (req, res) => {
  const ctx = await toolContext(req, res, null);
  res.json(await runQuery(ctx, String(req.params.source), req.body));
}));

app.post('/v1/writes/:write/prepare', route(async (req, res) => {
  const ctx = await toolContext(req, res, null);
  res.status(201).json(await prepareWrite(ctx, String(req.params.write), req.body?.params));
}));

app.post('/v1/writes/:write/apply', route(async (req, res) => {
  const ctx = await toolContext(req, res, null);
  res.status(201).json(await applyWrite(ctx, String(req.params.write), req.body?.params));
}));

app.post('/v1/writes/confirmations/:id/commit', route(async (req, res) => {
  const ctx = await toolContext(req, res, null);
  res.json(await commitWrite(ctx, String(req.params.id), req.body?.approval));
}));

// MCP для run-time агента. Stateless: каждый запрос несёт токен тула.
app.post('/mcp', route(async (req, res) => {
  const ctx = await toolContext(req, res, req.header('x-agent') ?? 'mcp-client');
  const server = createMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}));

app.all('/mcp', (_req, res) => {
  res.status(405).json({ error: 'method_not_allowed', message: 'MCP-эндпоинт stateless, используйте POST' });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Тело запроса не разобралось — это ошибка того, кто прислал, и ответ должен это объяснять, а не прятать в 500.
  if (err instanceof SyntaxError && 'body' in (err as { body?: unknown })) {
    res.status(400).json({ error: 'bad_request', message: `тело запроса не разобрано как JSON: ${err.message}` });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }
  console.error(JSON.stringify({ type: 'error', requestId: res.locals.requestId, error: String(err) }));
  res.status(500).json({ error: 'internal', message: 'внутренняя ошибка гейтвея', request_id: res.locals.requestId });
});

app.listen(config.port, () => {
  console.log(JSON.stringify({
    type: 'started',
    port: config.port,
    sources: Object.keys(registry.sources),
    writes: Object.keys(registry.writes),
  }));
});
