/**
 * /events — разбор журнала с фильтрами (П3) и активность одного тула (П4).
 * Сводка на главной отвечает «как дела», здесь отвечают на «кто и что делал и почему были отказы».
 * Фильтры живут в адресе: срез можно сохранить ссылкой и переслать.
 */
import type { Events, EventRow } from '../data.ts';
import { ago, badge, esc, layout } from '../html.ts';

const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Человеческое имя операции: в журнале они техничные, а читать их людям. */
export function operationName(op: string): string {
  if (op.startsWith('query:')) return `чтение · ${op.slice(6)}`;
  // Проверка личности на входе в гейтвей: в аудите она записана методом и путём запроса.
  if (op.startsWith('auth ')) return `проверка личности · ${op.slice(5).replace('/v1/', '')}`;
  // Отказ ForwardAuth до тула: в аудите он записан методом и путём — человеку нужен смысл, а не путь.
  if (op.startsWith('access ')) return `доступ к тулу · ${op.slice(7).replace('/v1/', '')}`;
  const known: Record<string, string> = {
    'write.prepare': 'запись подготовлена', 'write.apply': 'запись применена',
    'write.commit': 'запись подтверждена человеком', 'write.commit_approved': 'запись применена агентом с согласия',
    query: 'чтение', 'access.request': 'просит доступ', 'access.denied': 'не открыт доступ', 'tool.activity': 'смотрел активность', 'access.decide': 'решение по заявке', 'access.set': 'изменён доступ',
    'group.create': 'создана группа', 'group.delete': 'удалена группа',
    'group.member_add': 'участник добавлен', 'group.member_remove': 'участник убран',
    'key.issue': 'выпущен ключ', 'key.revoke': 'отозван ключ', 'key.revoke_all': 'отозваны все ключи',
    'key.denied': 'отказ по ключу', 'tool.register': 'допуск тула', 'tool.revoke': 'тул отозван',
    'tool.extend': 'тул продлён', 'tool.idle': 'простой', 'tool.prune': 'уборка истории', 'token.issue': 'выдан токен',
  };
  return known[op] ?? op;
}

const KINDS: [string, string][] = [['', 'все события'], ['read', 'чтение'], ['write', 'записи'], ['access', 'доступ и ключи'], ['admin', 'допуск и токены']];
const DAYS: [string, string][] = [['1', 'сутки'], ['7', 'неделя'], ['14', 'две недели'], ['30', 'месяц'], ['90', 'квартал']];

function filters(f: Events['filter'], facets: Events, action: string, fixedTool?: string): string {
  const option = (value: string, label: string, current: string) =>
    `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`;
  const select = (name: string, current: string, options: [string, string][]) =>
    `<select class="pt-search" name="${name}" style="max-width:190px">${options.map(([v, l]) => option(v, l, current)).join('')}</select>`;
  return `<form method="get" action="${action}" class="pt-actions" style="margin-bottom:14px;flex-wrap:wrap">
    ${select('days', String(f.days), DAYS)}
    ${fixedTool ? '' : select('tool', f.tool ?? '', [['', 'все тулы'], ...facets.tools.map((t) => [t, t] as [string, string])])}
    ${select('actor', f.actor ?? '', [['', 'все люди'], ...facets.actors.map((a) => [a, a] as [string, string])])}
    ${select('source', f.source ?? '', [['', 'все источники'], ...facets.sources.map((s) => [s, s] as [string, string])])}
    ${select('kind', f.kind ?? '', KINDS)}
    ${select('channel', f.channel ?? '', [['', 'браузер и агент'], ['web', 'только браузер'], ['mcp', 'только агент']])}
    <label class="sx-muted"><input type="checkbox" name="denied" value="1"${f.denied ? ' checked' : ''}> только отказы</label>
    <label class="sx-muted"><input type="checkbox" name="people" value="1"${f.people ? ' checked' : ''}> без служебных</label>
    <button class="sx-btn">Показать</button>
    <a class="sx-btn" href="${action}">Сбросить</a>
  </form>`;
}

/** Заголовок-ссылка: та же страница, тот же срез, другая сортировка — всё живёт в адресе. */
function sortable(action: string, query: string, column: string, label: string, current: string | undefined): string {
  const q = new URLSearchParams(query);
  q.set('sort', column);
  q.delete('offset');
  return `<th><a href="${action}?${q}">${esc(label)}</a>${current === column ? ' ↓' : ''}</th>`;
}

export function eventRow(e: EventRow, withTool = true): string {
  const who = `${esc(e.actor)}${e.agent_in_chain ? ` ${badge('info', 'через агента')}` : ''}`;
  return `<tr><td class="sx-muted" style="white-space:nowrap">${esc(when(e.at))}</td>
    <td>${who}</td>
    ${withTool ? `<td><a href="/tools/${esc(e.tool.split('--')[0]!)}">${esc(e.tool)}</a></td>` : ''}
    <td>${esc(operationName(e.operation))}${e.source ? ` <span class="sx-muted">${esc(e.source)}</span>` : ''}</td>
    <td>${e.allowed ? badge('ok', 'ок') : badge('bad', 'отказ')}</td>
    <td class="sx-muted">${esc(e.reason ?? (e.fields?.length ? `поля: ${e.fields.join(', ')}` : ''))}</td></tr>`;
}

export function renderEvents(p: { data: Events | Error; actor: string | null; tool?: string; query: string }): string {
  const title = p.tool ? `Активность тула ${p.tool}` : 'События';
  if (p.data instanceof Error) {
    return layout({ title, active: 'metrics', actor: p.actor, errors: [p.data], body: '' });
  }
  const d = p.data;
  const f = d.filter;
  const action = p.tool ? `/tools/${p.tool}/activity` : '/events';
  const th = (c: string, label: string) => sortable(action, p.query, c, label, f.sort ?? 'calls');
  const byActor = d.by_actor?.length
    ? `<div class="sx-card pt-tool"><div class="pt-head"><h2>Кто пользовался</h2><span class="sx-muted">за выбранный период · сортировка по заголовку</span></div>
       <div class="pt-scroll"><table class="pt-table"><tr>${th('actor', 'кто')}${th('calls', 'событий')}${th('via_agent', 'из них через агента')}${th('writes', 'записей')}${th('denied', 'отказов')}${th('tools', 'тулов')}${th('last_at', 'последний раз')}</tr>
       ${d.by_actor.map((a) => `<tr><td><a href="${action}?days=${f.days}&actor=${encodeURIComponent(a.actor)}">${esc(a.actor)}</a></td>
         <td>${a.calls}</td><td>${a.via_agent}</td><td>${a.writes}</td><td>${a.denied ? badge('bad', String(a.denied)) : '0'}</td>
         <td>${a.tools}</td><td class="sx-muted">${esc(ago(a.last_at))}</td></tr>`).join('')}</table></div></div>`
    : '';

  const next = d.rows.length === f.limit
    ? `<a class="sx-btn" href="${action}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(p.query)), offset: String(f.offset + f.limit) })}">Дальше →</a>`
    : '';
  const prev = f.offset > 0
    ? `<a class="sx-btn" href="${action}?${new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(p.query)), offset: String(Math.max(0, f.offset - f.limit)) })}">← Назад</a>`
    : '';

  const flip = new URLSearchParams(p.query);
  flip.set('order', f.order === 'asc' ? 'desc' : 'asc');
  flip.delete('offset');
  const timeHead = `<th><a href="${action}?${flip}">когда</a> ${f.order === 'asc' ? '↑' : '↓'}</th>`;
  const table = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Журнал</h2>
      <span class="sx-muted">${d.total} событий · ${d.denied} отказов · ${d.people} человек${p.tool ? '' : ` · ${esc(d.scope)}`}</span></div>
    ${d.rows.length ? `<div class="pt-scroll"><table class="pt-table"><tr>${timeHead}<th>кто</th>${p.tool ? '' : '<th>тул</th>'}<th>что</th><th></th><th>подробности</th></tr>
      ${d.rows.map((e) => eventRow(e, !p.tool)).join('')}</table></div>
      <div class="pt-actions" style="margin-top:10px">${prev}${next}</div>` : '<div class="sx-muted">по этому срезу событий нет</div>'}
  </div>`;

  return layout({
    title, active: 'metrics', actor: p.actor,
    lead: p.tool
      ? 'Кто пользовался тулом и что делал. Фильтры живут в адресе — срез можно переслать ссылкой.'
      : 'Разбор журнала: кто, что, где и почему отказ. Фильтры живут в адресе — срез можно сохранить ссылкой.',
    body: `${filters(f, d, action, p.tool)}${byActor}${table}`,
  });
}
