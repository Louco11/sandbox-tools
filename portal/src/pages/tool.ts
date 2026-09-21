/**
 * /tools/<тул> — страница тула: что умеет, как подключить к агенту, кто пользовался и что записывал (из аудита);
 * владельцу — продлить и удалить; разработчику — превью, ветки, лог последней выкатки.
 */
import { DOMAIN, TOOL_URL } from '../config.ts';
import type { AccessRequest, Activity, BranchInfo, Deploy, Events, GatewayTool, Manifest, Registry, ToolAccess, ToolMeta } from '../data.ts';
import { eventRow } from './events.ts';
import { ago, badge, branchLine, days, decides, deleteButton, esc, layout, lifetime } from '../html.ts';

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Кусок лога выкатки про этот тул: от «▶ <тул>» до следующего «▶». */
function deployLogFor(log: string, tool: string): string {
  const lines = log.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^▶ ${tool}( |$)`).test(l));
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && l.startsWith('▶ '));
  return lines.slice(start, end < 0 ? undefined : end).join('\n').trim();
}

function connectBlock(name: string, actor: string | null): string {
  const url = `${TOOL_URL(name)}/mcp`;
  const server = `sandbox-${name}`;
  const bridge = '<путь к репозиторию>/infra/mcp-bridge.ts';
  const cursor = JSON.stringify({ mcpServers: { [server]: { command: 'node', args: [bridge, url] } } }, null, 2);
  const desktop = cursor;
  return `<div class="sx-card pt-tool"><div class="pt-head"><h2>Подключить к агенту</h2></div>
    <div class="sx-muted">Агент получит действия тула как инструменты. Записывать он может только после вашего согласия в чате.</div>
    <div class="sx-notice" style="margin-top:8px">Сначала один раз войдите: <code>bin/sandbox-mcp login</code> — браузер подтвердит, что это вы${actor ? ` (${esc(actor)})` : ''},
      и личный ключ ляжет в Keychain. В конфигах ниже ключа нет: мост берёт его сам. Свои ключи — в <a href="/me">кабинете</a>,
      там же конфиг с ключом для хостов, которые ходят по HTTP напрямую.</div>
    <div class="pt-sec"><b>Claude Code</b><pre class="pt-code">claude mcp add ${esc(server)} -- node ${esc(bridge)} ${esc(url)}</pre></div>
    <div class="pt-sec"><b>Cursor — .cursor/mcp.json</b><pre class="pt-code">${esc(cursor)}</pre></div>
    <div class="pt-sec"><b>Claude Desktop — claude_desktop_config.json</b><pre class="pt-code">${esc(desktop)}</pre></div>
  </div>`;
}

/**
 * На карточке — короткий ответ: сколько вызовов, кто последние пятеро и что было только что.
 * Разбираться с фильтрами человек уходит на /tools/<тул>/activity: в карточке длинным таблицам не место (П4).
 */
function activityBlock(name: string, a: Activity | Error, last: Events | Error): string {
  if (a instanceof Error) return `<div class="sx-card pt-tool"><div class="sx-error">активность: ${esc(a.message)}</div></div>`;
  const people = a.people.slice(0, 5).map((p) => `<li><a href="/tools/${esc(name)}/activity?days=30&actor=${encodeURIComponent(p.actor)}">${esc(p.actor)}</a>
    <span class="sx-muted">${p.calls} вызов.${p.via_agent ? ` · ${p.via_agent} через агента` : ''} · ${esc(ago(p.last_at))}</span></li>`).join('');
  const rows = last instanceof Error || !last.rows.length ? '' : last.rows.slice(0, 5).map((e) => eventRow(e, false)).join('');
  return `<div class="sx-card pt-tool"><div class="pt-head"><h2>Кто пользовался</h2>
      <span class="sx-muted">30 дней · ${a.calls} вызовов · ${a.denied} отказов</span></div>
    <div class="pt-sec"><b>Люди · ${a.people.length}</b>
      ${people ? `<ul class="pt-list">${people}</ul>${a.people.length > 5 ? `<div class="sx-muted">и ещё ${a.people.length - 5}</div>` : ''}` : '<div class="sx-muted">никто — тул простаивает</div>'}</div>
    <div class="pt-sec"><b>Последние события людей</b>
      ${rows ? `<div class="pt-scroll"><table class="pt-table">${rows}</table></div>` : '<div class="sx-muted">событий нет</div>'}</div>
    <div class="pt-actions"><a class="sx-btn" href="/tools/${esc(name)}/activity">Вся активность и фильтры →</a></div>
  </div>`;
}

/** Заявки, ждущие решения: владелец закрывает их одной кнопкой, не вспоминая логин просителя. */
function requestsBlock(name: string, requests: AccessRequest[]): string {
  if (!requests.length) return '';
  const rows = requests.map((r) => `<tr><td><strong>${esc(r.login)}</strong>${r.note ? `<div class="sx-muted">${esc(r.note)}</div>` : ''}</td>
    <td class="sx-muted">${esc(ago(r.created_at))}</td>
    <td class="pt-actions" style="margin:0">
      <form method="post" action="/tools/${esc(name)}/requests" class="pt-inline" style="margin:0">
        <input type="hidden" name="id" value="${r.id}"><input type="hidden" name="decision" value="granted">
        <button class="sx-btn primary">Дать доступ</button></form>
      <form method="post" action="/tools/${esc(name)}/requests" class="pt-inline" style="margin:0">
        <input type="hidden" name="id" value="${r.id}"><input type="hidden" name="decision" value="denied">
        <button class="sx-btn">Отказать</button></form></td></tr>`).join('');
  return `<div class="sx-card pt-tool" style="border-color:var(--accent)">
    <div class="pt-head"><h2>Просят доступ</h2>${badge('warn', `${requests.length}`)}</div>
    <table class="pt-table">${rows}</table>
    <div class="sx-muted" style="margin-top:6px">«Дать доступ» добавляет человека лично — группы это не меняет. Решение уйдёт ему письмом и в аудит.</div></div>`;
}

/** Кому открыт тул: правит владелец или администратор, остальные видят и могут попросить доступ. */
function accessBlock(name: string, a: ToolAccess | null, may: boolean, actor: string | null, allowed: boolean, myRequest: AccessRequest | null): string {
  if (!a) return '';
  const chips = (xs: string[], kind: 'groups' | 'people') => xs.map((x) => `<span class="sx-badge info">${esc(x)}${may ? `
    <form method="post" action="/tools/${esc(name)}/access" class="pt-inline" style="margin:0 0 0 4px">
      <input type="hidden" name="remove" value="${esc(x)}"><input type="hidden" name="kind" value="${kind}">
      <button class="sx-btn" style="padding:0 4px;line-height:1">×</button></form>` : ''}</span>`).join(' ');
  const form = (kind: 'groups' | 'people', placeholder: string) => !may ? '' : `<form method="post" action="/tools/${esc(name)}/access" class="pt-actions" style="margin-top:6px">
      <input type="hidden" name="kind" value="${kind}"><input class="pt-search" name="add" placeholder="${placeholder}" style="max-width:220px" required>
      <button class="sx-btn">Добавить</button></form>`;
  const ask = may || allowed
    ? ''
    : myRequest?.status === 'pending'
      ? `<div class="sx-notice" style="margin-top:8px">Заявка отправлена ${esc(ago(myRequest.created_at))} — ждёт решения владельца.</div>`
      : `${myRequest?.status === 'denied' ? '<div class="sx-error" style="margin-top:8px">Прошлую заявку владелец отклонил.</div>' : ''}
        <form method="post" action="/tools/${esc(name)}/access-request" class="pt-actions" style="margin-top:8px">
          <input class="pt-search" name="note" placeholder="зачем нужен доступ" style="max-width:320px">
          <button class="sx-btn primary">Попросить доступ</button></form>`;
  return `<div class="sx-card pt-tool"><div class="pt-head"><h2>Доступ</h2><span class="sx-muted">меняется без передеплоя${a.updated_by ? `; правил ${esc(a.updated_by)}` : ''}</span></div>
    <div class="pt-kv"><span>группы</span><span>${chips(a.groups, 'groups') || '<span class="sx-muted">нет — только владелец</span>'}${form('groups', 'имя группы')}</span>
      <span>люди-исключения</span><span>${chips(a.people, 'people') || '<span class="sx-muted">нет</span>'}${form('people', 'логин')}</span>
      <span>агенты (MCP)</span><span>${a.agents ? badge('ok', 'разрешены') : badge('warn', 'только веб-интерфейс')}${may ? `
        <form method="post" action="/tools/${esc(name)}/access" class="pt-inline" style="margin-left:8px">
          <input type="hidden" name="agents" value="${a.agents ? 'off' : 'on'}"><button class="sx-btn">${a.agents ? 'Запретить' : 'Разрешить'}</button></form>` : ''}</span></div>
    ${ask}
    <div class="sx-muted" style="margin-top:8px">Круг ограничен и со стороны данных: шире, чем разрешил хранитель источника, тул открыть нельзя.
      Превью ветки видят владелец и одобряющие, а не все группы тула.</div></div>`;
}

export function renderTool(p: {
  name: string; t: GatewayTool | undefined; m: Manifest | undefined; meta: ToolMeta | null; registry: Registry | null;
  previews: GatewayTool[]; branches: BranchInfo[]; activity: Activity | Error; last: Events | Error; deploy: Deploy | null;
  access: ToolAccess | null; mayManage: boolean; allowed: boolean; requests: AccessRequest[]; myRequest: AccessRequest | null;
  actor: string | null; notice: string | null; problem: string | null; errors: Error[];
}): string {
  const { name, t, m, meta, registry } = p;
  const owner = t?.owner ?? m?.owner ?? '—';
  const owners = t?.owners;
  const alive = t && !t.revoked_at && days(t.expires_at) > 0;
  const writeIds = t?.writes ?? m?.writes ?? [];
  const writes = writeIds.map((w) => {
    const def = registry?.writes[w];
    return `<li><span>${esc(def?.title ?? w)}${def?.confirm ? ` ${badge('warn', 'с подтверждением')}` : ''}</span>
      <code class="sx-muted">${esc(w)}</code></li>`;
  }).join('');
  const sourceIds = t?.sources ?? m?.sources ?? [];
  const sources = sourceIds.map((id) => {
    const src = registry?.sources[id];
    return `<li><a href="/sources/${esc(id)}">${esc(src?.title ?? id)}</a>
      <span class="sx-muted">${esc(src ? Object.keys(src.datasets).join(', ') : 'нет в реестре')}</span></li>`;
  }).join('');
  const extend = !alive ? '' : !p.actor
    ? '<a class="sx-btn" href="/login">Продлить</a>'
    : !decides(p.actor, owner, owners)
      ? `<button class="sx-btn" disabled title="продлить может только владелец: ${esc(owner)}">Продлить</button>`
      : `<form method="post" action="/extend" class="pt-inline" style="margin:0"><input type="hidden" name="instance" value="${esc(name)}"><input type="hidden" name="back" value="/tools/${esc(name)}"><button class="sx-btn">Продлить на ${m?.ttl_days ?? 30} дн.</button></form>`;
  // Постороннему — только что это за тул и чей он: состав источников и прав записи ему видеть незачем.
  const about = !p.allowed && !p.mayManage
    ? `<div class="sx-card pt-tool"><div class="pt-head"><h2>О туле</h2>${badge('warn', 'вам не открыт')}</div>
       <div class="pt-facts"><div><b>инстанс</b><code>${esc(name)}</code></div>
         <div><b>владелец</b>${esc(owner)}</div></div>
       <p class="pt-desc" style="max-width:56ch">${esc(meta?.description ?? 'описание появится, когда вам откроют тул')}</p></div>`
    // Факты — короткими карточками в несколько колонок, списки — вниз на всю ширину: широкие колонки
    // «поле — длинный текст» читать невозможно (П5).
    : `<div class="sx-card pt-tool"><div class="pt-head"><h2>О туле</h2>${alive ? `<a class="sx-btn primary" href="${TOOL_URL(name)}">Открыть</a>` : badge('bad', 'не работает')}</div>
    <div class="pt-facts">
      <div><b>инстанс</b>${alive ? `<a href="${TOOL_URL(name)}">${esc(name)}.${esc(DOMAIN)}</a>` : `<code>${esc(name)}</code>`}</div>
      <div><b>владелец</b>${esc(owner)}${t?.owner_note ? `<div class="sx-error" style="margin:4px 0 0">${esc(t.owner_note)}</div>` : owners && owners.length > 1 ? `<div class="sx-muted">группа: ${esc(owners.join(', '))}</div>` : ''}</div>
      <div><b>интерфейсы</b>${(meta?.ui ?? []).map((u) => badge('info', u === 'web' ? 'браузер' : 'MCP App')).join(' ') || '—'}</div>
      <div style="grid-column:1/-1"><b>срок жизни</b>${t ? lifetime(t) : '<span class="sx-muted">ещё не выкачен</span>'}</div>
    </div>
    <div class="pt-sec"><b>Источники · ${sourceIds.length}</b>${sources ? `<ul class="pt-list">${sources}</ul>` : '<div class="sx-muted">нет — тул не ходит за данными</div>'}</div>
    <div class="pt-sec"><b>Права записи · ${writeIds.length}</b>${writes ? `<ul class="pt-list">${writes}</ul>` : '<div class="sx-muted">только чтение</div>'}</div>
    ${alive ? `<div class="pt-actions">${extend}${deleteButton('/revoke', 'instance', name, 'Удалить', `Удалить тул ${name}? Контейнер удалится в течение минуты, данные в источниках останутся.`, owner, p.actor, owners)}</div>` : ''}
  </div>`;
  const actions = meta?.actions.length
    ? `<div class="sx-card pt-tool"><div class="pt-head"><h2>Что умеет</h2><span class="sx-muted">действия — они же инструменты агента</span></div>
      <table class="pt-table">${meta.actions.map((a) => `<tr><td><code>${esc(a.name)}</code></td><td>${esc(a.description)}</td></tr>`).join('')}</table></div>` : '';
  const log = p.deploy?.log ? deployLogFor(p.deploy.log, name) : '';
  const dev = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Разработчику</h2></div>
    <div class="pt-sec"><b>Превью · ${p.previews.length}</b>${p.previews.map((v) => `<div><a href="${TOOL_URL(v.name)}">${esc(v.name)}</a> <span class="sx-muted">ещё ${days(v.expires_at)} дн.</span></div>`).join('') || '<div class="sx-muted">нет</div>'}</div>
    <div class="pt-sec"><b>Изменения в ветках · ${p.branches.length}</b>${p.branches.map((b) => branchLine(b, p.previews)).join('') || '<div class="sx-muted">нет — всё в main</div>'}</div>
    <div class="pt-sec"><b>Последняя выкатка main</b>${p.deploy ? `${badge(p.deploy.state === 'success' ? 'ok' : p.deploy.state === 'failure' ? 'bad' : 'warn', p.deploy.state)} <span class="sx-muted">${esc(ago(p.deploy.finished_at ?? p.deploy.started_at ?? null))}</span>${log ? `<pre class="pt-code">${esc(log)}</pre>` : ''}` : '<div class="sx-muted">нет данных деплоера</div>'}</div>
  </div>`;

  return layout({
    title: meta?.title ?? name, active: 'catalog', actor: p.actor, notice: p.notice, problem: p.problem, errors: p.errors,
    lead: meta?.description ?? (t || m ? 'описание недоступно — тул не отвечает' : 'такого тула нет'),
    body: `<div class="pt-grid">${p.mayManage ? requestsBlock(name, p.requests) : ''}${about}${accessBlock(name, p.access, p.mayManage, p.actor, p.allowed, p.myRequest)}${p.allowed ? `${actions}${connectBlock(name, p.actor)}${activityBlock(name, p.activity, p.last)}${dev}` : ''}</div>`,
  });
}
