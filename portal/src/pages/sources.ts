/**
 * /sources и /sources/<id> — одобренные источники: наборы данных, поля и их чувствительность, права записи
 * (важные — с подтверждением), кто одобрил и какие тулы пользуются. Только чтение: реестр — решение человека.
 */
import type { GatewayTool, Registry } from '../data.ts';
import { badge, days, esc, layout } from '../html.ts';

const SENS: Record<string, string> = { public: 'ok', internal: 'info', confidential: 'warn', personal: 'bad' };
const SENS_RU: Record<string, string> = { public: 'публичное', internal: 'внутреннее', confidential: 'конфиденциальное', personal: 'персональное' };
const sens = (s: string) => badge(SENS[s] ?? 'info', SENS_RU[s] ?? s);

type Common = { actor: string | null; errors: Error[] };
const aliveProd = (gw: GatewayTool[]) => gw.filter((t) => !t.name.includes('--') && !t.revoked_at && days(t.expires_at) > 0);

function writesOf(r: Registry, source: string) {
  return Object.entries(r.writes).filter(([, w]) => w.source === source);
}

export function renderSources(p: Common & { registry: Registry | null; gw: GatewayTool[] }): string {
  const r = p.registry;
  const tools = aliveProd(p.gw);
  const cards = r ? Object.entries(r.sources).map(([id, s]) => {
    const users = tools.filter((t) => t.sources.includes(id));
    const levels = [...new Set(Object.values(s.datasets).flatMap((d) => Object.values(d.fields)))];
    const w = writesOf(r, id);
    return `<div class="sx-card pt-tool"><div class="pt-head"><h2><a href="/sources/${esc(id)}">${esc(s.title)}</a></h2></div>
      <div class="sx-muted"><code>${esc(id)}</code> · владелец ${esc(s.owner)} · одобрил ${esc(s.approved_by)} ${esc(s.approved_at)}</div>
      <div class="pt-meta">${Object.keys(s.datasets).map((d) => badge('info', d, 'набор данных')).join('')}</div>
      <div class="pt-meta">${levels.map(sens).join('')}</div>
      <div class="sx-muted">${w.length ? `права записи: ${w.length}` : 'только чтение'} · тулов: ${users.length}</div>
    </div>`;
  }).join('') : '';
  return layout({
    title: 'Источники данных', active: 'sources', actor: p.actor, errors: p.errors,
    lead: 'К каким данным у тулов есть доступ. Список ведут ИБ и владельцы данных в реестре — тул не может выйти за него.',
    body: `${r?.reload_error ? `<div class="sx-error">реестр не перечитан, действует прежний: ${esc(r.reload_error)}</div>` : ''}
<div class="pt-grid">${cards || '<div class="sx-card sx-empty">реестр недоступен</div>'}</div>`,
  });
}

export function renderSource(p: Common & { id: string; registry: Registry | null; gw: GatewayTool[] }): string {
  const s = p.registry?.sources[p.id];
  if (!p.registry || !s) {
    return layout({ title: p.id, active: 'sources', actor: p.actor, errors: p.errors, body: '<div class="sx-card sx-empty">такого источника в реестре нет</div>' });
  }
  // Кому видны чувствительные поля и чьи строки — решение хранителя данных; показываем рядом с полями.
  const fieldGroups = s.field_groups ?? {};
  const whoSees = (lvl: string) => {
    const groups = fieldGroups[lvl];
    return groups?.length ? ` <span class="sx-muted">— только ${esc(groups.join(', '))}</span>` : '';
  };
  const datasets = Object.entries(s.datasets).map(([name, d]) => {
    const rf = d.row_filter;
    return `<div class="sx-card pt-tool"><div class="pt-head"><h2>${esc(name)}</h2><span class="sx-muted">${esc(d.description)}</span></div>
    <table class="pt-table"><tr><th>поле</th><th>чувствительность</th></tr>${Object.entries(d.fields).map(([f, lvl]) => `<tr><td><code>${esc(f)}</code></td><td>${sens(lvl)}${whoSees(lvl)}</td></tr>`).join('')}</table>
    ${rf ? `<div class="pt-sec"><b>Кто какие строки видит</b>
      <div>по полю <code>${esc(rf.field)}</code>: ${Object.entries(rf.by_group).map(([g, v]) => `${badge('info', g)} <span class="sx-muted">${esc(v.join(', '))}</span>`).join(' · ')}</div>
      ${rf.unrestricted_groups.length ? `<div class="sx-muted">без ограничения: ${esc(rf.unrestricted_groups.join(', '))}</div>` : ''}</div>` : ''}</div>`;
  }).join('');
  const writes = writesOf(p.registry, p.id).map(([id, w]) => `<div class="sx-card pt-tool"><div class="pt-head"><h2>${esc(w.title)}</h2>${w.confirm ? badge('warn', 'важное — с подтверждением') : badge('ok', 'сразу из интерфейса')}</div>
    <div class="sx-muted"><code>${esc(id)}</code> · одобрил ${esc(w.approved_by)} ${esc(w.approved_at)}</div>
    <table class="pt-table"><tr><th>параметр</th><th>тип</th><th></th></tr>${Object.entries(w.params).map(([k, v]) => `<tr><td><code>${esc(k)}</code>${v.required ? '' : ' <span class="sx-muted">необяз.</span>'}</td><td>${esc(v.values ? v.values.join(' | ') : v.type)}</td><td class="sx-muted">${esc(v.description ?? '')}</td></tr>`).join('')}</table></div>`).join('');
  const users = aliveProd(p.gw).filter((t) => t.sources.includes(p.id));
  return layout({
    title: s.title, active: 'sources', actor: p.actor, errors: p.errors,
    lead: `${p.id} · владелец ${s.owner} · одобрил ${s.approved_by} ${s.approved_at}`
      + `${s.allowed_groups?.length ? ` · открыт группам: ${s.allowed_groups.join(', ')}` : ''}`,
    body: `<h2>Наборы данных</h2><div class="pt-grid">${datasets}</div>
<h2>Права записи</h2><div class="pt-grid">${writes || '<div class="sx-card sx-empty">только чтение</div>'}</div>
<h2>Тулы, которые пользуются источником</h2><div class="sx-card pt-tool">${users.map((t) => `<div><a href="/tools/${esc(t.name)}">${esc(t.name)}</a> <span class="sx-muted">владелец ${esc(t.owner)}${t.writes.some((w) => p.registry!.writes[w]?.source === p.id) ? ' · пишет' : ''}</span></div>`).join('') || '<span class="sx-muted">никто</span>'}</div>`,
  });
}
