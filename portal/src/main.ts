/**
 * Главная страница песочницы — каталог и рабочее место:
 *   /                каталог тулов в проде: поиск, открыть, подключить к агенту;
 *   /tools/<тул>     что умеет, как подключить к агенту, кто пользовался и что записывал, продлить/удалить, превью;
 *   /sources[/<id>]  одобренные источники: поля и чувствительность, права записи, кто пользуется;
 *   /metrics         метрики: воронка до прода, выживаемость, использование, спрос на источники;
 *   /events          разбор журнала с фильтрами; /tools/<тул>/activity — то же по одному тулу;
 *   /new-tool        как подключить песочницу к своему агенту и собрать тул;
 *   /platform        здоровье: гейтвей, реестр, коннекторы, деплоер, уборщик, CI;
 *   /dev             разработчику: ветки, PR, превью, рабочая копия стенда;
 *   /inbox           уведомления человека (заглушка почтового ящика до мессенджера или почты компании);
 *   /me              кабинет: кто я, мои группы и тулы, личные ключи MCP;
 *   /admin           администратору песочницы: группы, люди, журнал.
 * Из действий — только владельцу тула: продление, отзыв инстанса и PR на удаление кода.
 *   http://tools.localhost:18000 (в локальной сети — http://<SANDBOX_DOMAIN>:18000)
 *
 * Источники: гейтвей (тулы, реестр, аудит, состояние), Gitea (ветки, PR, CI), деплоер, /_meta тулов,
 * git рабочей копии (смонтирована read-only). Без npm-зависимостей. Вход — заглушка SSO, как в тулах.
 */
import http from 'node:http';
import { DOMAIN, IDENTITY_HEADER, PORT, PUBLIC_PORT } from './config.ts';
import {
  activity, deployerHealth, events, deployOf, gatewayTools, inbox, metrics, notifierHealth, startsOf, localState, mainHead, mainTools, markRead, platform, recentDeploys, recentRuns,
  addMember, allowedTools, createGroup, deleteGroup, groups, groupsOf, issueMcpKey, journal, keysOf, myKeys, registry,
  decideAccessRequest, myAccessRequests, removeMember, repoState, requestAccess, revokeAllKeys, revokeMcpKey,
  setToolAccess, toolAccess, toolMeta, toolRequests,
  type AccessRequest, type Local, type ToolAccess, type ToolMeta,
} from './data.ts';
import { extendInstance, openRemovalPr, revokeInstance, type Person } from './actions.ts';
import { render as renderDev } from './pages/dev.ts';
import { renderCatalog } from './pages/catalog.ts';
import { renderTool } from './pages/tool.ts';
import { renderSource, renderSources } from './pages/sources.ts';
import { renderPlatform } from './pages/platform.ts';
import { renderInbox } from './pages/inbox.ts';
import { renderMetrics } from './pages/metrics.ts';
import { renderEvents } from './pages/events.ts';
import { renderNewTool } from './pages/newtool.ts';
import { renderMe } from './pages/me.ts';
import { renderAdmin } from './pages/admin.ts';
import { ADMIN_MARK, INBOX_MARK, INSIDER_MARK } from './html.ts';

const settle = <T>(p: Promise<T>) => p.catch((e: Error) => new Error(e.message));
const ok = <T>(v: T | Error, empty: T): T => (v instanceof Error ? empty : v);
const errs = (...vs: unknown[]) => vs.filter((e): e is Error => e instanceof Error);

const ACTOR = /^[a-z][a-z0-9._-]{1,63}$/;
const TOOL = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * Кто перед нами — из подписанной личности, которую поставил Traefik после входа в IdP (шаг Б1).
 * Подпись проверяет гейтвей; главная только читает логин и пересылает заголовок дальше.
 */
function identityOf(req: http.IncomingMessage): { actor: string; groups: string[] } | null {
  const raw = req.headers[IDENTITY_HEADER] as string | undefined;
  const payload = raw?.split('.')[1];
  if (!payload) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub?: string; groups?: string[] };
    return typeof p.sub === 'string' && ACTOR.test(p.sub) ? { actor: p.sub, groups: Array.isArray(p.groups) ? p.groups : [] } : null;
  } catch {
    return null;
  }
}
const actorOf = (req: http.IncomingMessage): string | null => identityOf(req)?.actor ?? null;

const redirect = (res: http.ServerResponse, to: string, cookie?: string) =>
  res.writeHead(303, { Location: to, ...(cookie ? { 'Set-Cookie': cookie } : {}) }).end();

/** Куда вернуть после действия: только путь этого же портала. */
function backOf(req: http.IncomingMessage, form: URLSearchParams): string {
  const safe = (p: string | null | undefined) => (p && p.startsWith('/') && !p.startsWith('//') ? p : null);
  let ref: string | null = null;
  try { ref = req.headers.referer ? new URL(req.headers.referer).pathname : null; } catch { /* нет или битый */ }
  return safe(form.get('back')) ?? safe(ref) ?? '/';
}
const withParam = (path: string, k: string, v: string) => `${path}${path.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`;

async function formBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  return new URLSearchParams(raw);
}

type McpKeyList = Awaited<ReturnType<typeof keysOf>>['keys'];

/** Кнопки на странице тула меняют доступ по одному шагу: добавить, убрать, разрешить агентов. */
function accessPatch(current: ToolAccess, f: URLSearchParams): { groups?: string[]; people?: string[]; agents?: boolean } {
  const agents = f.get('agents');
  if (agents) return { agents: agents === 'on' };
  const kind = f.get('kind') === 'people' ? 'people' : 'groups';
  const add = (f.get('add') ?? '').trim();
  const remove = (f.get('remove') ?? '').trim();
  const list = new Set(current[kind]);
  if (add) list.add(add);
  if (remove) list.delete(remove);
  return { [kind]: [...list] };
}

async function adminAction(path: string, identity: string, cookie: string, f: URLSearchParams): Promise<string> {
  const group = f.get('group') ?? '';
  const login = f.get('login') ?? '';
  switch (path) {
    case '/admin/groups':
      await createGroup(identity, (f.get('name') ?? '').trim(), (f.get('title') ?? '').trim());
      return `Группа ${f.get('name')} создана`;
    case '/admin/groups/delete':
      await deleteGroup(identity, f.get('name') ?? '');
      return `Группа ${f.get('name')} удалена — её права пропадут у людей на следующем вызове`;
    case '/admin/members':
      await addMember(identity, group, login, (f.get('days') ?? '').trim());
      return `${login} в группе ${group}${f.get('days') ? ` на ${f.get('days')} дн.` : ''}`;
    case '/admin/members/remove':
      await removeMember(identity, group, login);
      return `${login} убран из группы ${group}`;
    case '/admin/keys/revoke':
      await revokeMcpKey(cookie, f.get('prefix') ?? '');
      return `Ключ ${f.get('prefix')} отозван`;
    case '/admin/keys/revoke-all': {
      const n = await revokeAllKeys(cookie, f.get('owner') ?? '');
      return `Отозвано ключей: ${n.revoked}`;
    }
    default:
      throw new Error('нет такого действия');
  }
}

const ACTIONS: Record<string, (actor: Person, form: URLSearchParams) => Promise<string>> = {
  '/revoke': (a, f) => revokeInstance(a, f.get('instance') ?? ''),
  '/remove-code': (a, f) => openRemovalPr(a, f.get('tool') ?? ''),
  '/extend': (a, f) => extendInstance(a, f.get('instance') ?? ''),
};

/** Кабинет: ключи берём от имени самого человека — пересылаем его куку входа в сервис личности. */
async function mePage(req: http.IncomingMessage, url: URL, me: { actor: string; groups: string[] }, fresh: { key: string; name: string; replaced: string | null } | null): Promise<string> {
  const cookie = req.headers.cookie ?? '';
  const [keys, gw, main] = await Promise.all([settle(myKeys(cookie)), settle(gatewayTools()), settle(mainTools())]);
  return renderMe({
    actor: me.actor, groups: me.groups,
    keys: keys instanceof Error ? keys : keys.keys,
    graceHours: keys instanceof Error ? 24 : keys.grace_hours,
    tools: ok(gw, []).filter((t) => !t.revoked_at), inMain: new Set(ok(main, new Map()).keys()),
    fresh, notice: url.searchParams.get('ok'), problem: url.searchParams.get('error'),
  });
}

const ADMINS_GROUP = 'sandbox-admins';
const APPROVERS_GROUP = 'sandbox-approvers';

/**
 * Что человеку показывать (П2). Каталог, своя страница тула, кабинет и уведомления — всем вошедшим.
 * Состояние платформы, ветки и PR — администраторам, одобряющим и владельцам тулов: это кухня, а не витрина.
 */
async function viewerRights(me: { actor: string; groups: string[] } | null): Promise<{ admin: boolean; insider: boolean }> {
  if (!me) return { admin: false, insider: false };
  const admin = me.groups.includes(ADMINS_GROUP);
  if (admin) return { admin, insider: true };
  const owns = await gatewayTools()
    .then((tools) => tools.some((t) => !t.revoked_at && t.owners.includes(me.actor)))
    .catch(() => false);
  return { admin, insider: owns || me.groups.includes(APPROVERS_GROUP) };
}

const forbiddenPage = (res: http.ServerResponse, what: string) =>
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' }).end(
    `<!doctype html><meta charset="utf-8"><title>Нет доступа</title>
     <body style="font-family:system-ui;max-width:460px;margin:15vh auto;padding:0 16px">
     <h2 style="margin-bottom:4px">${what} — не для всех</h2>
     <p style="color:#666">Это видно владельцам тулов, одобряющим и администраторам песочницы.
     Вам открыт <a href="/">каталог ваших тулов</a> и <a href="/me">кабинет</a>.</p>`,
  );

/** Администрирование: страницу показываем участникам sandbox-admins, права всё равно проверяет гейтвей. */
async function adminPage(req: http.IncomingMessage, url: URL, me: { actor: string; groups: string[] }): Promise<string> {
  const login = url.searchParams.get('login')?.trim() ?? '';
  const cookie = req.headers.cookie ?? '';
  const [gs, jr] = await Promise.all([settle(groups()), settle(journal())]);
  let person: { login: string; groups: string[]; keys: McpKeyList } | null = null;
  if (ACTOR.test(login)) {
    const [pg, pk] = await Promise.all([settle(groupsOf(login)), settle(keysOf(cookie, login))]);
    person = { login, groups: ok(pg, []), keys: pk instanceof Error ? [] : pk.keys };
  }
  return renderAdmin({
    actor: me.actor, groups: gs, journal: jr, person,
    notice: url.searchParams.get('ok'), problem: url.searchParams.get('error'),
  });
}

async function page(url: URL, actor: string | null, me?: { actor: string; groups: string[] } | null, identity?: string): Promise<string | null> {
  const notice = url.searchParams.get('ok');
  const problem = url.searchParams.get('error');
  const path = url.pathname;

  if (path === '/') {
    const [gw, main] = await Promise.all([settle(gatewayTools()), settle(mainTools())]);
    const tools = ok(gw, []).filter((t) => !t.name.includes('--') && !t.revoked_at);
    const metas = new Map<string, ToolMeta | null>(await Promise.all(tools.map(async (t) => [t.name, await toolMeta(t.name)] as const)));
    const allowed: Record<string, boolean> = me ? await allowedTools(me.actor, me.groups, tools.map((t) => t.name)).catch(() => ({})) : {};
    return renderCatalog({ gw: ok(gw, []), main: ok(main, new Map()), metas, q: url.searchParams.get('q') ?? '', allowed, actor, notice, problem, errors: errs(gw, main) });
  }

  const tool = path.match(/^\/tools\/([^/]+)$/)?.[1];
  if (tool) {
    if (!TOOL.test(tool)) return null;
    const [gw, main, reg, repo, act, meta, head] = await Promise.all([
      settle(gatewayTools()), settle(mainTools()), settle(registry()), settle(repoState()), settle(activity(tool)),
      toolMeta(tool), settle(mainHead()),
    ]);
    // Последние события — тем же запросом, что и страница активности: на карточке их пять (П4).
    const last = await settle(events(identity, new URLSearchParams({ tool, days: '30', limit: '5', people: '1' })));
    const all = ok(gw, []);
    const deploy = head instanceof Error ? null : await deployOf(head).catch(() => null);
    const row = all.find((t) => t.name === tool);
    const access = await toolAccess(tool).catch(() => null);
    const mayManage = Boolean(me && row && (row.owners.includes(me.actor) || me.groups.includes(ADMINS_GROUP)));
    const allowed = me && row ? (await allowedTools(me.actor, me.groups, [tool]).catch(() => ({} as Record<string, boolean>)))[tool] !== false : false;
    // Заявки: владельцу — ждущие решения, просителю — его собственная, чтобы не просить дважды.
    const requests: AccessRequest[] = mayManage ? await toolRequests(tool).catch(() => []) : [];
    const mine = me && !allowed ? await myAccessRequests(me.actor).catch(() => []) : [];
    const myRequest = mine.find((r) => r.tool === tool) ?? null;
    return renderTool({
      access, mayManage, allowed, requests, myRequest,
      name: tool, t: all.find((t) => t.name === tool), m: ok(main, new Map()).get(tool), meta, registry: ok(reg, null),
      previews: all.filter((t) => t.name.startsWith(`${tool}--`) && !t.revoked_at),
      branches: ok(repo, { branches: [], merged: [], pulls: [] }).branches.filter((b) => b.tools.includes(tool)),
      activity: act, last, deploy, actor, notice, problem, errors: errs(gw, main, reg, repo),
    });
  }

  if (path === '/new-tool') {
    const gw = await settle(gatewayTools());
    return renderNewTool({ actor, tools: ok(gw, []).filter((t) => !t.name.includes('--') && !t.revoked_at).length });
  }

  // Журнал с фильтрами: общий (/events) и по одному тулу — та же страница, тот же срез в адресе.
  const activityOf = path.match(/^\/tools\/([^/]+)\/activity$/)?.[1];
  if (path === '/events' || activityOf) {
    if (activityOf && !TOOL.test(activityOf)) return null;
    const q = new URLSearchParams(url.search);
    q.set('by', 'actor');
    if (activityOf) q.set('tool', activityOf);
    return renderEvents({ data: await settle(events(identity, q)), actor, tool: activityOf, query: url.search.slice(1) });
  }

  if (path === '/sources' || path.startsWith('/sources/')) {
    const [reg, gw] = await Promise.all([settle(registry()), settle(gatewayTools())]);
    const common = { registry: ok(reg, null), gw: ok(gw, []), actor, errors: errs(reg, gw) };
    return path === '/sources' ? renderSources(common) : renderSource({ ...common, id: decodeURIComponent(path.slice('/sources/'.length)) });
  }

  if (path === '/metrics') {
    const [m, main] = await Promise.all([settle(metrics(identity)), settle(mainTools())]);
    const names = m instanceof Error ? [] : [...new Set([...m.firsts.map((f) => f.tool), ...m.lives.map((l) => l.name)])];
    const starts = await startsOf(names, ok(main, new Map()));
    return renderMetrics({ m, starts, actor });
  }

  if (path === '/platform') {
    const [pl, deployer, deploys, runs, notifier] = await Promise.all([settle(platform()), deployerHealth(), settle(recentDeploys()), settle(recentRuns()), notifierHealth()]);
    return renderPlatform({ platform: pl, deployer, deploys, runs, notifier, actor });
  }

  if (path === '/inbox') {
    if (!actor) return null;
    const box = await settle(inbox(actor));
    await markRead(actor).catch(() => undefined);
    return renderInbox({ actor, messages: box instanceof Error ? box : box.messages });
  }

  if (path === '/dev') {
    const [gw, main, repo] = await Promise.all([settle(gatewayTools()), settle(mainTools()), settle(repoState())]);
    let local: Local | Error;
    try {
      local = localState();
    } catch (e) {
      local = e as Error;
    }
    return renderDev({ gw, main, repo, local, actor, notice, problem });
  }
  return null;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://portal');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }

  // Вход и выход — в сервисе личности: сюда запрос доходит только после входа в IdP (ForwardAuth).
  if (url.pathname === '/login' || url.pathname === '/logout') {
    const next = `http://${DOMAIN}:${PUBLIC_PORT}/`;
    return redirect(res, `http://id.${DOMAIN}:${PUBLIC_PORT}${url.pathname}?next=${encodeURIComponent(next)}`);
  }

  // Доступ к тулу: правит владелец или администратор, заявку пишет любой вошедший. Проверяет гейтвей.
  const accessRoute = /^\/tools\/([a-z][a-z0-9-]{0,62})\/(access|access-request|requests)$/.exec(url.pathname);
  if (req.method === 'POST' && accessRoute) {
    const me = identityOf(req);
    const identity = req.headers[IDENTITY_HEADER] as string | undefined;
    if (!me || !identity) return redirect(res, '/login');
    const [, tool, what] = accessRoute;
    const form = await formBody(req);
    const back = `/tools/${tool}`;
    try {
      if (what === 'access-request') {
        const msg = await requestAccess(identity, tool!, (form.get('note') ?? '').trim());
        return redirect(res, withParam(back, 'ok', msg));
      }
      if (what === 'requests') {
        const decision = form.get('decision') === 'granted' ? 'granted' : 'denied';
        const msg = await decideAccessRequest(identity, tool!, Number(form.get('id')), decision);
        console.log(JSON.stringify({ type: 'action', action: 'access.decide', actor: me.actor, target: tool, decision }));
        return redirect(res, withParam(back, 'ok', msg));
      }
      const current = await toolAccess(tool!);
      const patch = accessPatch(current, form);
      const next = await setToolAccess(identity, tool!, patch);
      console.log(JSON.stringify({ type: 'action', action: 'access.set', actor: me.actor, target: tool, groups: next.groups, people: next.people, agents: next.agents }));
      return redirect(res, withParam(back, 'ok', `Доступ обновлён: ${next.groups.join(', ') || 'только владелец'}${next.people.length ? `; люди: ${next.people.join(', ')}` : ''}`));
    } catch (e) {
      return redirect(res, withParam(back, 'error', (e as Error).message));
    }
  }

  // Администрирование: изменения уходят в гейтвей и сервис личности от имени человека — они и проверяют права.
  if (req.method === 'POST' && url.pathname.startsWith('/admin/')) {
    const me = identityOf(req);
    const identity = req.headers[IDENTITY_HEADER] as string | undefined;
    if (!me || !identity) return redirect(res, '/login');
    const form = await formBody(req);
    const back = form.get('login') ? `/admin?login=${encodeURIComponent(form.get('login')!)}` : '/admin';
    try {
      const msg = await adminAction(url.pathname, identity, req.headers.cookie ?? '', form);
      console.log(JSON.stringify({ type: 'action', action: url.pathname, actor: me.actor, result: msg }));
      return redirect(res, withParam(back, 'ok', msg));
    } catch (e) {
      return redirect(res, withParam(back, 'error', (e as Error).message));
    }
  }

  // Ключи MCP: выпуск и отзыв — от имени человека, его кукой входа. Ключ показывается один раз, в ответе.
  if (req.method === 'POST' && (url.pathname === '/me/keys' || url.pathname === '/me/keys/revoke')) {
    const me = identityOf(req);
    if (!me) return redirect(res, '/login');
    const form = await formBody(req);
    try {
      if (url.pathname === '/me/keys/revoke') {
        const prefix = form.get('prefix') ?? '';
        await revokeMcpKey(req.headers.cookie ?? '', prefix);
        console.log(JSON.stringify({ type: 'action', action: 'key.revoke', actor: me.actor, target: prefix }));
        return redirect(res, withParam('/me', 'ok', `Ключ ${prefix} отозван — подключения с ним больше не работают`));
      }
      const name = (form.get('name') ?? '').trim() || 'без названия';
      const issued = await issueMcpKey(req.headers.cookie ?? '', name, form.get('replace') ?? undefined);
      console.log(JSON.stringify({ type: 'action', action: 'key.issue', actor: me.actor, target: issued.prefix, replaced: issued.replaced }));
      const html = await mePage(req, url, me, { key: issued.key, name: issued.name, replaced: issued.replaced });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(html.replace(INBOX_MARK, '').replace(ADMIN_MARK, me.groups.includes(ADMINS_GROUP) ? ' · <a href="/admin">админ</a>' : ''));
      return;
    } catch (e) {
      return redirect(res, withParam('/me', 'error', (e as Error).message));
    }
  }

  const action = req.method === 'POST' ? ACTIONS[url.pathname] : undefined;
  if (action) {
    const actor = actorOf(req);
    if (!actor) return redirect(res, '/login');
    const person: Person = { login: actor, identity: (req.headers[IDENTITY_HEADER] as string | undefined) ?? null };
    const form = await formBody(req);
    const back = backOf(req, form).replace(/[?].*$/, '');
    try {
      const msg = await action(person, form);
      console.log(JSON.stringify({ type: 'action', action: url.pathname, actor, target: form.get('instance') ?? form.get('tool'), result: msg }));
      return redirect(res, withParam(back, 'ok', msg));
    } catch (e) {
      return redirect(res, withParam(back, 'error', (e as Error).message));
    }
  }

  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  try {
    const me = identityOf(req);
    const actor = me?.actor ?? null;
    if ((url.pathname === '/inbox' || url.pathname === '/me' || url.pathname === '/admin') && !actor) return redirect(res, '/login');
    const rights = await viewerRights(me);
    if (url.pathname === '/admin' && !rights.admin) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('администрирование песочницы — для группы sandbox-admins');
      return;
    }
    // Кухня платформы: состояние сервисов, ветки и PR, устройство источников.
    const inner = ['/platform', '/dev', '/sources'];
    if (!rights.insider && (inner.includes(url.pathname) || url.pathname.startsWith('/sources/'))) {
      return void forbiddenPage(res, url.pathname === '/dev' ? 'Разработчику' : url.pathname === '/platform' ? 'Платформа' : 'Источники');
    }
    let html = url.pathname === '/me' && me
      ? await mePage(req, url, me, null)
      : url.pathname === '/admin' && me
        ? await adminPage(req, url, me)
        : await page(url, actor, me, req.headers[IDENTITY_HEADER] as string | undefined);
    if (html !== null && actor) {
      const unread = url.pathname === '/inbox' ? 0 : await inbox(actor).then((b) => b.unread, () => 0);
      html = html.replace(INBOX_MARK, unread ? ` <span class="sx-badge bad">${unread}</span>` : '');
      html = html.replace(ADMIN_MARK, rights.admin ? ' · <a href="/admin">админ</a>' : '');
      // Ссылки на кухню платформы показываем только тем, кому эти страницы открыты.
      if (!rights.insider) html = html.replace(/<!--insider-start-->[\s\S]*?<!--insider-end-->/g, '');
      html = html.replace(INSIDER_MARK, '').replace(/<!--insider-(start|end)-->/g, '');
    }
    html = html?.replace(ADMIN_MARK, '').replace(INSIDER_MARK, '').replace(/<!--insider-(start|end)-->/g, '') ?? null;
    if (html === null) res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('нет такой страницы');
    else res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end((e as Error).message);
  }
}).listen(PORT, () => console.log(JSON.stringify({ type: 'started', port: PORT })));
