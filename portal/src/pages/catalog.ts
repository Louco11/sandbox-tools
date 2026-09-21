/** / — каталог тулов для всех: что есть в проде, для чего, чей, сколько живёт; поиск, открыть, подключить к агенту. */
import { TOOL_URL } from '../config.ts';
import type { GatewayTool, Manifest, ToolMeta } from '../data.ts';
import { badge, days, esc, layout } from '../html.ts';

export function renderCatalog(p: {
  gw: GatewayTool[]; main: Map<string, Manifest>; metas: Map<string, ToolMeta | null>; q: string;
  allowed: Record<string, boolean>;
  actor: string | null; notice: string | null; problem: string | null; errors: Error[];
}): string {
  const live = p.gw.filter((t) => !t.name.includes('--') && p.main.has(t.name) && !t.revoked_at && days(t.expires_at) > 0);
  // Каталог показывает человеку его тулы; о чужих он узнаёт от владельца, а не из списка.
  const alive = live.filter((t) => p.allowed[t.name] !== false);
  const hidden = live.length - alive.length;
  const q = p.q.trim().toLowerCase();
  const found = alive.filter((t) => {
    if (!q) return true;
    const m = p.metas.get(t.name);
    return [t.name, t.owner, m?.title, m?.description, ...t.sources].some((s) => String(s ?? '').toLowerCase().includes(q));
  }).sort((a, b) => a.name.localeCompare(b.name));

  const cards = found.map((t) => {
    const m = p.metas.get(t.name);
    const left = days(t.expires_at);
    const life = t.idle_notified_at
      ? badge('bad', `простой — удаление через ${left} дн.`)
      : left <= 7 ? badge('warn', `истекает через ${left} дн.`) : badge('ok', `ещё ${left} дн.`);
    return `<div class="sx-card pt-tool">
      <div class="pt-head"><h2><a href="/tools/${esc(t.name)}">${esc(m?.title ?? t.name)}</a></h2>${life}</div>
      <div class="sx-muted"><code>${esc(t.name)}</code> · владелец ${esc(t.owner)}${t.owner_note ? ` ${badge('warn', 'владелец ушёл', t.owner_note)}` : ''}</div>
      <div class="pt-desc">${m ? esc(m.description) : '<span class="sx-muted">описание недоступно — тул не отвечает</span>'}</div>
      <div class="pt-meta">${t.sources.map((s) => `<a href="/sources/${esc(s)}">${badge('info', s, 'источник данных')}</a>`).join('')}
        ${t.writes.length ? badge('warn', `✎ ${t.writes.length} прав записи`, t.writes.join(', ')) : badge('ok', 'только чтение')}</div>
      <div class="pt-actions"><a class="sx-btn primary" href="${TOOL_URL(t.name)}">Открыть</a><a class="sx-btn" href="/tools/${esc(t.name)}">Подробнее и подключение к агенту</a></div>
    </div>`;
  }).join('');

  return layout({
    title: 'Каталог тулов', active: 'catalog', actor: p.actor, notice: p.notice, problem: p.problem, errors: p.errors,
    lead: 'Внутренние инструменты песочницы: открыть в браузере или подключить к агенту',
    body: `<form method="get" action="/" style="margin-bottom:14px"><input class="pt-search" name="q" value="${esc(p.q)}" placeholder="Поиск: название, задача, владелец, источник" autofocus></form>
<div class="sx-stats"><div class="sx-stat"><b>${alive.length}</b><span>тулов в проде</span></div>
<div class="sx-stat"><b>${alive.filter((t) => days(t.expires_at) <= 7 || t.idle_notified_at).length}</b><span>истекает ≤ 7 дней</span></div>
<div class="sx-stat"><b>${new Set(alive.map((t) => t.owner)).size}</b><span>владельцев</span></div></div>
${hidden ? `<div class="sx-muted" style="margin:-6px 0 14px">Ещё ${hidden} тулов вам не открыты — доступ даёт их владелец.</div>` : ''}
<div class="sx-card pt-tool" style="margin-bottom:12px"><div class="pt-row">
  <div><b>Нужного тула нет?</b> <span class="sx-muted">Его соберёт ваш агент — песочница подключается к нему одной командой.</span></div>
  <a class="sx-btn primary" href="/new-tool" style="margin-left:auto">Создать тул</a></div></div>
<div class="pt-grid">${cards || `<div class="sx-card sx-empty">${q ? `По «${esc(p.q)}» ничего не нашлось` : 'Тулов пока нет'}</div>`}</div>`,
  });
}
