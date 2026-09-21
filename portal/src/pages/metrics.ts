/**
 * /metrics — сколько стоит тул и сколько их выживает (шаг А5): воронка «начат → превью → прод → жив 30 и 90 дней»,
 * время до превью и до прода, использование людьми, спрос на источники. Только агрегаты из гейтвея и Gitea.
 *
 * Что считать «использованием» — решение людей (roadmap, раздел 4): показываем меры рядом и не выбираем за них.
 */
import type { Metrics } from '../data.ts';
import { badge, esc, layout } from '../html.ts';

const DAY = 86_400_000;
const ms = (iso: string) => new Date(iso).getTime();

function dur(from: string, to: string): string {
  const d = ms(to) - ms(from);
  if (d < 0) return '—';
  const m = Math.round(d / 60_000);
  if (m < 60) return `${m} мин`;
  if (m < 48 * 60) return `${Math.floor(m / 60)} ч ${m % 60} мин`;
  return `${Math.round(d / DAY)} дн.`;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}
const durMs = (d: number | null) => (d === null ? '—' : dur(new Date(0).toISOString(), new Date(d).toISOString()));
const when = (iso: string) => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const bar = (v: number, max: number) => `<span style="display:inline-block;height:8px;border-radius:4px;background:var(--accent);width:${max ? Math.max(2, Math.round((v / max) * 120)) : 0}px;vertical-align:middle;margin-right:6px"></span>${v}`;

const END: Record<string, [string, string]> = {
  revoked: ['warn', 'удалён владельцем'], idle: ['bad', 'умер от простоя'], expired: ['bad', 'истёк срок'],
};

/** Выживаемость за N дней: из тулов, родившихся не позже N дней назад, — сколько прожили N дней. */
function survival(lives: Metrics['lives'], n: number) {
  const cohort = lives.filter((l) => Date.now() - ms(l.born_at) >= n * DAY);
  const alive = cohort.filter((l) => !l.ended_at || ms(l.ended_at) - ms(l.born_at) >= n * DAY);
  return { cohort: cohort.length, alive: alive.length };
}

export function renderMetrics(p: { m: Metrics | Error; starts: Map<string, { at: string; exact: boolean }>; actor: string | null }): string {
  if (p.m instanceof Error) return layout({ title: 'Метрики', active: 'metrics', actor: p.actor, errors: [p.m], body: '' });
  const { lives, firsts, weekly, tools, sources, people, denials } = p.m;
  const now = new Date().toISOString();

  // Воронка: каждый тул конвейера — от начала работы до выживания.
  const names = [...new Set([...firsts.map((f) => f.tool), ...lives.map((l) => l.name)])].sort();
  const first = new Map(firsts.map((f) => [f.tool, f]));
  const lifeOf = (t: string) => lives.filter((l) => l.name === t).at(-1);
  const toPreview: number[] = [];
  const toProd: number[] = [];
  for (const t of names) {
    const s = p.starts.get(t)?.at;
    const f = first.get(t);
    if (s && f?.first_preview && ms(f.first_preview) > ms(s)) toPreview.push(ms(f.first_preview) - ms(s));
    if (s && f?.first_prod && ms(f.first_prod) > ms(s)) toProd.push(ms(f.first_prod) - ms(s));
  }
  const s30 = survival(lives, 30);
  const s90 = survival(lives, 90);
  const oldest = lives.length ? Math.floor((Date.now() - Math.min(...lives.map((l) => ms(l.born_at)))) / DAY) : 0;
  const rate = (s: { cohort: number; alive: number }) => (s.cohort ? `${Math.round((s.alive / s.cohort) * 100)}%` : '—');
  const last30 = tools.reduce((a, t) => ({ person_days: a.person_days + t.person_days, calls: a.calls + t.calls, writes: a.writes + t.writes }), { person_days: 0, calls: 0, writes: 0 });

  const stats = `<div class="sx-stats">
    <div class="sx-stat"><b>${lives.filter((l) => !l.ended_at).length}</b><span>тулов в проде</span></div>
    <div class="sx-stat"><b>${durMs(median(toPreview))}</b><span>медиана: начало → превью</span></div>
    <div class="sx-stat"><b>${durMs(median(toProd))}</b><span>медиана: начало → прод</span></div>
    <div class="sx-stat"><b>${rate(s30)}</b><span>живы через 30 дней${s30.cohort ? ` (${s30.alive} из ${s30.cohort})` : ''}</span></div>
    <div class="sx-stat"><b>${rate(s90)}</b><span>живы через 90 дней${s90.cohort ? ` (${s90.alive} из ${s90.cohort})` : ''}</span></div>
    <div class="sx-stat"><b>${last30.person_days}</b><span>человеко-дней за 30 дней</span></div>
  </div>
  ${!s30.cohort ? `<div class="sx-muted" style="margin:-6px 0 14px">Выживаемость появится, когда тулам будет 30 и 90 дней: самому старому — ${oldest} дн.</div>` : ''}`;

  const usage = new Map(tools.map((t) => [t.tool, t]));
  const rows = names.map((t) => {
    const st = p.starts.get(t);
    const f = first.get(t);
    const life = lifeOf(t);
    const u = usage.get(t);
    const status = !life ? badge('info', f?.first_preview ? 'только превью' : '—')
      : !life.ended_at ? badge('ok', `жив ${Math.floor((Date.now() - ms(life.born_at)) / DAY)} дн.`)
        : badge(...(END[life.end_reason ?? ''] ?? ['bad', life.end_reason ?? 'закончился']));
    return `<tr><td><a href="/tools/${esc(t)}">${esc(t)}</a></td>
      <td>${st ? `${esc(when(st.at))}${st.exact ? '' : ' <span class="sx-muted" title="отметки scaffold_tool нет — первый коммит tool.yaml в main">*</span>'}` : '—'}</td>
      <td>${f?.first_preview ? (st ? dur(st.at, f.first_preview) : esc(when(f.first_preview))) : '—'}</td>
      <td>${f?.first_prod ? (st ? dur(st.at, f.first_prod) : esc(when(f.first_prod))) : '—'}</td>
      <td>${status}</td>
      <td>${u?.people ?? 0}</td><td>${u?.person_days ?? 0}</td><td>${u?.calls ?? 0}</td><td>${u?.writes ?? 0}</td>
      <td><a href="/tools/${esc(t)}/activity?days=30">разобрать</a></td></tr>`;
  }).join('');
  const funnel = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Тулы: от начала работы до выживания</h2><span class="sx-muted">использование — за 30 дней, без превью</span></div>
    <table class="pt-table"><tr><th>тул</th><th>начат</th><th>→ превью</th><th>→ прод</th><th>сейчас</th><th>людей</th><th>чел.-дней</th><th>вызовов</th><th>записей</th><th></th></tr>${rows}</table>
    <div class="sx-muted" style="margin-top:6px">* у тулов, созданных до отметки начала в scaffold_tool, начало — первый коммит в main, то есть скорее конец работы. «→ превью» меньше нуля — тул выкатывали до коммита, показано «—».</div></div>`;

  const maxW = Math.max(1, ...weekly.map((w) => w.calls));
  const maxP = Math.max(1, ...weekly.map((w) => w.person_days));
  const weeks = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Использование по неделям</h2><span class="sx-muted">люди, не агенты сами по себе; 12 недель</span></div>
    ${weekly.length ? `<table class="pt-table"><tr><th>неделя</th><th>людей</th><th>человеко-дней</th><th>вызовов</th><th>из них с агентом</th><th>завершённых записей</th><th>тулов</th></tr>
      ${weekly.map((w) => `<tr><td>с ${esc(new Date(w.week).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }))}</td><td>${w.people}</td><td>${bar(w.person_days, maxP)}</td><td>${bar(w.calls, maxW)}</td><td>${w.via_agent}</td><td>${w.writes}</td><td>${w.tools}</td></tr>`).join('')}</table>` : '<div class="sx-muted">вызовов людей не было</div>'}
    <div class="sx-muted" style="margin-top:6px">Что считать использованием — открытие, завершённое действие или снятые человеко-часы — решают люди (план, раздел 4).
      Здесь меры рядом: человеко-дни ближе к «открытию», завершённые записи — к «действию»; человеко-часы из аудита не посчитать — нужна оценка владельцев.</div></div>`;

  const maxS = Math.max(1, ...sources.map((s) => s.reads + s.writes));
  const src = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Спрос на источники · 30 дней</h2><span class="sx-muted">подключать следующий источник — туда, где спрос</span></div>
    <table class="pt-table"><tr><th>источник</th><th>обращений</th><th>из них записей</th><th>людей</th><th>тулов пользуются / объявили</th></tr>
    ${sources.map((s) => `<tr><td><a href="/sources/${esc(s.source)}">${esc(s.title)}</a> <a class="sx-muted" href="/events?days=30&source=${encodeURIComponent(s.source)}">события</a></td><td>${bar(s.reads + s.writes, maxS)}</td><td>${s.writes}</td><td>${s.people}</td>
      <td>${s.tools_used} / ${s.tools_declared}${s.reads + s.writes === 0 ? ` ${badge('warn', 'одобрен, но не нужен')}` : ''}</td></tr>`).join('')}</table></div>`;

  // Разрезы, за которыми раньше лезли в psql: кто пользуется и на чём спотыкается (П3).
  const maxC = Math.max(1, ...people.map((x) => x.calls));
  const whoCard = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Кто пользуется · 30 дней</h2>
      <a href="/events?days=30&people=1">разобрать по событиям →</a></div>
    ${people.length ? `<table class="pt-table"><tr><th>кто</th><th>вызовов</th><th>дней с заходом</th><th>записей</th><th>тулов</th><th>последний раз</th></tr>
      ${people.map((x) => `<tr><td><a href="/events?days=30&actor=${encodeURIComponent(x.actor)}">${esc(x.actor)}</a></td>
        <td>${bar(x.calls, maxC)}</td><td>${x.person_days}</td><td>${x.writes}</td><td>${x.tools}</td>
        <td class="sx-muted">${esc(when(x.last_at))}</td></tr>`).join('')}</table>` : '<div class="sx-muted">людей в аудите за 30 дней нет</div>'}</div>`;

  const denyCard = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Отказы · 30 дней</h2>
      <a href="/events?days=30&denied=1&people=1">разобрать по событиям →</a></div>
    ${denials.length ? `<table class="pt-table"><tr><th>тул</th><th>сколько</th><th>людей</th><th>почему</th><th>последний раз</th></tr>
      ${denials.map((d) => `<tr><td><a href="/tools/${esc(d.tool)}/activity?days=30&denied=1">${esc(d.tool)}</a></td>
        <td>${badge('bad', String(d.calls))}</td><td>${d.people}</td><td class="sx-muted">${esc(d.reason ?? 'без причины')}</td>
        <td class="sx-muted">${esc(when(d.last_at))}</td></tr>`).join('')}</table>
      <div class="sx-muted" style="margin-top:6px">Отказ — это чаще не поломка, а граница, которую человек не понял: доступ к тулу, поле по группам, строки не его круга. Одинаковые отказы подряд — повод поправить круг или текст.</div>`
      : '<div class="sx-muted">отказов не было</div>'}</div>`;

  return layout({
    title: 'Метрики', active: 'metrics', actor: p.actor, refresh: 300,
    lead: `Сколько стоит тул и сколько их выживает. Считаются тулы, прошедшие конвейер (выкатывал деплоер); данные — аудит гейтвея и Gitea, на ${when(now)}.`,
    body: `${stats}<div class="pt-actions" style="margin:-6px 0 12px"><a class="sx-btn" href="/events">Разобрать события с фильтрами →</a></div>
      <div class="pt-grid" style="grid-template-columns:1fr">${funnel}${whoCard}${denyCard}${weeks}${src}</div>`,
  });
}
