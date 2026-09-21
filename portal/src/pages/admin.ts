/**
 * /admin — администрирование песочницы (шаг Б3): группы, люди, журнал. Видят только участники sandbox-admins;
 * все изменения идут в гейтвей от имени человека, он же проверяет права и пишет аудит.
 *
 * Групп две породы: зеркало IdP (отдел, должность) — здесь только для просмотра, менять их в IdP;
 * группы песочницы — заводятся под задачу и живут здесь.
 */
import type { Group, JournalRow, McpKey } from '../data.ts';
import { ago, badge, esc, layout } from '../html.ts';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const left = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);

const OPERATION: Record<string, string> = {
  'group.create': 'создана группа', 'group.delete': 'удалена группа',
  'group.member_add': 'участник добавлен', 'group.member_remove': 'участник убран',
  'key.issue': 'выпущен ключ', 'key.revoke': 'отозван ключ', 'key.revoke_all': 'отозваны все ключи',
  'key.denied': 'отказ по ключу',
};

function groupCard(g: Group): string {
  const members = g.members.map((m) => {
    const expired = m.expires_at && new Date(m.expires_at).getTime() <= Date.now();
    const term = !m.expires_at ? '' : expired ? ` ${badge('bad', 'срок вышел')}` : ` ${badge('warn', `ещё ${left(m.expires_at)} дн.`)}`;
    return `<tr><td>${esc(m.login)}${term}</td><td class="sx-muted">добавил ${esc(m.added_by)} ${esc(ago(m.added_at))}</td>
      <td><form method="post" action="/admin/members/remove" class="pt-inline" style="margin:0">
        <input type="hidden" name="group" value="${esc(g.name)}"><input type="hidden" name="login" value="${esc(m.login)}">
        <button class="sx-btn pt-del">Убрать</button></form></td></tr>`;
  }).join('');
  return `<div class="sx-card pt-tool"><div class="pt-head"><h2>${esc(g.title)}</h2><code class="sx-muted">${esc(g.name)}</code></div>
    <div class="sx-muted">завёл ${esc(g.created_by)} ${esc(ago(g.created_at))} · участников: ${g.members.length}</div>
    ${members ? `<table class="pt-table">${members}</table>` : '<div class="sx-muted" style="margin-top:6px">пока никого</div>'}
    <form method="post" action="/admin/members" class="pt-actions" style="margin-top:10px">
      <input type="hidden" name="group" value="${esc(g.name)}">
      <input class="pt-search" name="login" placeholder="логин" style="max-width:200px" required>
      <input class="pt-search" name="days" placeholder="дней (пусто — бессрочно)" style="max-width:190px">
      <button class="sx-btn">Добавить</button></form>
    <form method="post" action="/admin/groups/delete" class="pt-actions" onsubmit="return confirm('Удалить группу ${esc(g.name)}? Участники потеряют её права на следующем вызове.')">
      <input type="hidden" name="name" value="${esc(g.name)}"><button class="sx-btn pt-del">Удалить группу</button></form>
  </div>`;
}

export function renderAdmin(p: {
  actor: string; groups: Group[] | Error; journal: JournalRow[] | Error;
  person: { login: string; groups: string[]; keys: McpKey[] } | null;
  notice: string | null; problem: string | null;
}): string {
  const groups = p.groups instanceof Error ? [] : p.groups;
  const journal = p.journal instanceof Error ? [] : p.journal;

  const list = `<div class="pt-grid">${groups.map(groupCard).join('') || '<div class="sx-card sx-empty">Групп песочницы пока нет</div>'}</div>`;

  const create = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Новая группа</h2><span class="sx-muted">под задачу: «Кондитерская — склад», «Пилот продаж»</span></div>
    <form method="post" action="/admin/groups" class="pt-actions">
      <input class="pt-search" name="name" placeholder="имя: pastry-stock" style="max-width:220px" required>
      <input class="pt-search" name="title" placeholder="как называть людям" style="max-width:320px">
      <button class="sx-btn primary">Создать</button></form>
    <div class="sx-muted" style="margin-top:8px">Группы из IdP (отдел, должность) здесь не заводятся: они приходят в личности человека, менять их — в IdP.
      Роли <code>sandbox-admins</code> и <code>sandbox-approvers</code> тоже задаёт IdP.</div></div>`;

  const person = p.person
    ? `<div class="sx-card pt-tool"><div class="pt-head"><h2>${esc(p.person.login)}</h2></div>
        <div class="pt-kv"><span>группы песочницы</span><span>${p.person.groups.map((g) => badge('info', g)).join('') || '<span class="sx-muted">нет</span>'}</span></div>
        <div class="pt-sec"><b>Ключи MCP</b>${p.person.keys.length ? `<table class="pt-table">
          ${p.person.keys.map((k) => `<tr><td>${esc(k.name)}<div class="sx-muted"><code>sbx_${esc(k.prefix)}_…</code></div></td>
            <td>${k.revoked_at ? badge('bad', `отозван ${esc(k.revoked_by ?? '')}`) : badge('ok', `ещё ${left(k.expires_at)} дн.`)}</td>
            <td class="sx-muted">${k.last_used_at ? esc(ago(k.last_used_at)) : 'не пользовались'}</td>
            <td>${k.revoked_at ? '' : `<form method="post" action="/admin/keys/revoke" class="pt-inline" style="margin:0">
              <input type="hidden" name="owner" value="${esc(k.owner)}"><input type="hidden" name="prefix" value="${esc(k.prefix)}">
              <button class="sx-btn pt-del">Отозвать</button></form>`}</td></tr>`).join('')}</table>` : '<div class="sx-muted">ключей нет</div>'}</div>
        <form method="post" action="/admin/keys/revoke-all" class="pt-actions" onsubmit="return confirm('Отозвать все ключи ${esc(p.person.login)}? Все его подключения оборвутся сразу.')">
          <input type="hidden" name="owner" value="${esc(p.person.login)}"><button class="sx-btn pt-del">Отозвать все ключи — утечка</button></form>
      </div>`
    : '';

  const search = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Человек</h2><span class="sx-muted">в каких группах и чем подключается</span></div>
    <form method="get" action="/admin" class="pt-actions"><input class="pt-search" name="login" placeholder="логин" style="max-width:220px" value="${esc(p.person?.login ?? '')}">
      <button class="sx-btn">Посмотреть</button></form></div>`;

  const log = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Журнал</h2><span class="sx-muted">кто что менял — из аудита</span></div>
    ${journal.length ? `<table class="pt-table">${journal.map((r) => `<tr><td class="sx-muted">${esc(when(r.at))}</td><td>${esc(r.actor)}</td>
      <td>${esc(OPERATION[r.operation] ?? r.operation)}${r.allowed ? '' : ` ${badge('bad', 'отказ')}`}</td>
      <td class="sx-muted">${esc(r.reason ?? '')}</td></tr>`).join('')}</table>` : '<div class="sx-muted">пока пусто</div>'}</div>`;

  return layout({
    title: 'Администрирование', active: 'admin', actor: p.actor, notice: p.notice, problem: p.problem,
    errors: [p.groups, p.journal].filter((e): e is Error => e instanceof Error),
    lead: 'Группы песочницы, люди и журнал. Доступ к тулам по группам — следующий шаг плана (Б4).',
    body: `${search}${person}${create}${list}${log}`,
  });
}
