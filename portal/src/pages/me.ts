/**
 * /me — кабинет человека (шаг Б2): кто я и в каких группах, мои тулы, мои ключи MCP.
 * Ключ принадлежит человеку, а не тулу: одним ключом подключаются все доступные ему тулы, права проверяются
 * на каждом вызове. Сам ключ показывается ровно один раз — сразу после выпуска, вместе с готовыми конфигами.
 */
import { DOMAIN, PUBLIC_PORT, TOOL_URL } from '../config.ts';
import type { GatewayTool, McpKey } from '../data.ts';
import { ago, badge, esc, layout } from '../html.ts';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const left = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

function keyRow(k: McpKey, actor: string): string {
  const dead = k.revoked_at && new Date(k.revoked_at).getTime() <= Date.now();
  const state = dead
    ? badge('bad', `отозван ${k.revoked_by === actor ? 'вами' : k.revoked_by ?? ''}`.trim(), k.revoke_reason ?? '')
    : k.revoked_at
      ? badge('warn', `работает до ${when(k.revoked_at)}`, 'перевыпущен: прежний ключ доживает')
      : left(k.expires_at) <= 14 ? badge('warn', `истекает через ${left(k.expires_at)} дн.`) : badge('ok', `ещё ${left(k.expires_at)} дн.`);
  const used = k.last_used_at ? `${esc(ago(k.last_used_at))}${k.last_agent ? ` · ${esc(k.last_agent)}` : ''}${k.last_ip ? ` · ${esc(k.last_ip)}` : ''}` : '<span class="sx-muted">не пользовались</span>';
  const actions = dead ? '' : `<form method="post" action="/me/keys" class="pt-inline" style="margin:0">
      <input type="hidden" name="replace" value="${esc(k.prefix)}"><input type="hidden" name="name" value="${esc(k.name)}">
      <button class="sx-btn">Перевыпустить</button></form>
    <form method="post" action="/me/keys/revoke" class="pt-inline" onsubmit="return confirm('Отозвать ключ «${esc(k.name)}»? Подключения с ним перестанут работать сразу.')">
      <input type="hidden" name="prefix" value="${esc(k.prefix)}"><button class="sx-btn pt-del">Отозвать</button></form>`;
  return `<tr><td>${esc(k.name)}<div class="sx-muted"><code>sbx_${esc(k.prefix)}_…</code></div></td>
    <td>${state}</td><td>${used}</td><td>${esc(when(k.created_at))}${k.created_by !== k.owner ? `<div class="sx-muted">выпустил ${esc(k.created_by)}</div>` : ''}</td>
    <td class="pt-actions" style="margin:0">${actions}</td></tr>`;
}

/** Конфиги подключения с уже вставленным ключом — их видно один раз, вместе с самим ключом. */
function configs(key: string, tool: string): string {
  const url = `${TOOL_URL(tool)}/mcp`;
  const server = `sandbox-${tool}`;
  const cursor = JSON.stringify({ mcpServers: { [server]: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  return `<div class="pt-sec"><b>Claude Code</b><pre class="pt-code">claude mcp add --transport http ${esc(server)} ${esc(url)} --header "Authorization: Bearer ${esc(key)}"</pre></div>
    <div class="pt-sec"><b>Cursor — .cursor/mcp.json</b><pre class="pt-code">${esc(cursor)}</pre></div>
    <div class="pt-sec"><b>Claude Desktop — через мост</b><pre class="pt-code">${esc(JSON.stringify({ mcpServers: { [server]: { command: 'node', args: ['<путь к репозиторию>/infra/mcp-bridge.ts', url], env: { SANDBOX_MCP_KEY: key } } } }, null, 2))}</pre></div>
    <div class="sx-muted">Тем, кто ходит мостом, ключ в конфиге не нужен — он берётся из Keychain. Адрес другого тула — такой же, с его именем: <code>http://&lt;тул&gt;.${esc(DOMAIN)}:${esc(PUBLIC_PORT)}/mcp</code>. Ключ один на все доступные вам тулы.</div>`;
}

export function renderMe(p: {
  actor: string; groups: string[]; keys: McpKey[] | Error; graceHours: number;
  tools: GatewayTool[]; inMain: Set<string>; fresh: { key: string; name: string; replaced: string | null } | null;
  notice: string | null; problem: string | null;
}): string {
  const keys = p.keys instanceof Error ? [] : p.keys;
  const mine = p.tools.filter((t) => t.owners.includes(p.actor) && !t.name.includes('--') && p.inMain.has(t.name));
  const anyTool = p.tools.find((t) => !t.name.includes('--'))?.name ?? 'manager-board';

  // Ключ мог отозвать администратор — человек должен узнать об этом, а не гадать, почему агент замолчал.
  const byAdmin = keys.filter((k) => k.revoked_at && k.revoked_by && k.revoked_by !== p.actor && Date.now() - new Date(k.revoked_at).getTime() < 7 * 86_400_000);
  const warning = byAdmin.length
    ? `<div class="sx-error">Ваш ключ ${byAdmin.map((k) => `«${esc(k.name)}»`).join(', ')} отозвал ${esc(byAdmin[0]!.revoked_by!)}${byAdmin[0]!.revoke_reason ? `: ${esc(byAdmin[0]!.revoke_reason)}` : ''}.
       Выпустите новый ключ ниже и обновите подключение — <code>bin/sandbox-mcp login</code>.</div>`
    : '';

  const who = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Это вы</h2><a class="sx-btn" href="/logout">Выйти</a></div>
    <div class="pt-kv"><span>логин</span><span><code>${esc(p.actor)}</code></span>
      <span>группы</span><span>${p.groups.length ? p.groups.map((g) => badge('info', g)).join('') : '<span class="sx-muted">только вы сами</span>'}</span>
      <span>ваши тулы</span><span>${mine.length ? mine.map((t) => `<a href="/tools/${esc(t.name)}">${esc(t.name)}</a>`).join(', ') : '<span class="sx-muted">нет — вы ничей владелец</span>'}</span>
    </div></div>`;

  const freshBlock = p.fresh
    ? `<div class="sx-card pt-tool" style="border-color:var(--accent)"><div class="pt-head"><h2>Ключ «${esc(p.fresh.name)}» выпущен</h2>${badge('warn', 'виден один раз')}</div>
        <pre class="pt-code">${esc(p.fresh.key)}</pre>
        <div class="sx-muted">Больше он нигде не хранится: в базе только префикс и хэш. Потеряли — перевыпустите.
          ${p.fresh.replaced ? `Прежний ключ <code>${esc(p.fresh.replaced)}</code> доживает ${p.graceHours} ч, чтобы подключения не оборвались.` : ''}</div>
        ${configs(p.fresh.key, anyTool)}</div>`
    : '';

  const list = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Ключи MCP</h2><span class="sx-muted">ключ у человека, а не у тула: права перечитываются на каждом вызове</span></div>
    ${p.keys instanceof Error ? `<div class="sx-error">${esc(p.keys.message)}</div>` : ''}
    ${keys.length ? `<table class="pt-table"><tr><th>название</th><th>состояние</th><th>последний раз</th><th>выпущен</th><th></th></tr>
      ${keys.map((k) => keyRow(k, p.actor)).join('')}</table>` : '<div class="sx-muted">ключей нет — агент будет спрашивать вход в браузере каждый раз</div>'}
    <form method="post" action="/me/keys" class="pt-actions" style="margin-top:12px">
      <input class="pt-search" name="name" placeholder="Название: ноутбук, Claude Desktop" style="max-width:320px" required>
      <button class="sx-btn primary">Выпустить ключ</button></form>
    <div class="sx-muted" style="margin-top:8px">Утёк ключ — отзовите его здесь: подключения с ним перестанут работать сразу, остальные ключи продолжат.</div>
  </div>`;

  return layout({
    title: 'Кабинет', active: 'me', actor: p.actor, notice: p.notice, problem: p.problem,
    lead: 'Кто вы для песочницы, что вам доступно и чем подключаются ваши агенты',
    body: `${warning}<div class="pt-grid" style="grid-template-columns:1fr">${who}${freshBlock}${list}</div>`,
  });
}
