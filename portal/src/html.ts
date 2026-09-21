/** Представление: помощники разметки и общая раскладка страниц главной. */
import { css as kitCss } from '../../packages/ui-kit/src/styles.ts';
import { DAY, DOMAIN, GITEA_PUBLIC, REPO, TOOL_URL } from './config.ts';
import { branchSlug, type BranchInfo, type GatewayTool, type PullInfo } from './data.ts';

export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const badge = (tone: string, text: string, title = '') => `<span class="sx-badge ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
export const days = (iso: string) => Math.ceil((new Date(iso).getTime() - Date.now()) / DAY);

export function ago(iso: string | null): string {
  if (!iso) return 'никогда';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'только что';
  if (m < 60) return `${m} мин назад`;
  if (m < 60 * 24) return `${Math.round(m / 60)} ч назад`;
  return `${Math.round(m / 60 / 24)} дн назад`;
}

export function ciBadge(state: string): string {
  const map: Record<string, [string, string]> = {
    success: ['ok', 'CI ✓'], failure: ['bad', 'CI ✗'], error: ['bad', 'CI ✗'], pending: ['warn', 'CI …'], нет: ['info', 'CI —'],
  };
  const [tone, text] = map[state] ?? ['info', `CI ${state}`];
  return badge(tone, text);
}

export function lifetime(t: GatewayTool): string {
  if (t.revoked_at) return `${badge('bad', 'удалён')} <span class="sx-muted">отозван ${esc(ago(t.revoked_at))}, контейнер убирает уборщик</span>`;
  const left = days(t.expires_at);
  if (left <= 0) return badge('bad', 'срок истёк');
  const tone = t.idle_notified_at ? 'bad' : left <= 7 ? 'warn' : 'ok';
  const status = t.idle_notified_at ? 'простой — будет удалён' : left <= 7 ? 'скоро истекает' : 'активен';
  const cap = t.auto_extend_until ? Math.max(1, days(t.auto_extend_until)) : null;
  const pct = cap ? Math.min(100, Math.round((left / cap) * 100)) : 100;
  return `${badge(tone, status)} <b>${left} дн.</b> <span class="sx-muted">до ${new Date(t.expires_at).toLocaleDateString('ru-RU')}</span>
    <div class="pt-bar" title="срок / предел автопродления"><i class="${tone}" style="width:${pct}%"></i></div>
    <div class="sx-muted">${cap ? `автопродление до ${new Date(t.auto_extend_until!).toLocaleDateString('ru-RU')}` : 'без автопродления'} · заход человека: ${esc(ago(t.last_human_at))}</div>`;
}

export function prLine(p: PullInfo): string {
  const review = p.changesRequested.length
    ? badge('bad', 'нужны правки', p.changesRequested.join(', '))
    : p.approvedBy.length ? badge('ok', `одобрен: ${p.approvedBy.join(', ')}`) : badge('warn', 'ждёт одобрения');
  return `<a href="${esc(p.url)}">PR #${p.number}</a> ${esc(p.title)} ${review} ${ciBadge(p.ci)}${p.mergeable ? '' : ` ${badge('bad', 'конфликт')}`}`;
}

export function branchLine(b: BranchInfo, previews: GatewayTool[]): string {
  const prev = previews.filter((p) => p.name.endsWith(`--${branchSlug(b.name)}`) && !p.revoked_at && days(p.expires_at) > 0);
  const links = prev.map((p) => `<a href="${TOOL_URL(p.name)}">${esc(p.name)}</a>`).join(', ');
  return `<div class="pt-branch">
    <div><code>${esc(b.name)}</code> ${ciBadge(b.ci)} <span class="sx-muted">+${b.ahead} коммит. · ${esc(b.author)} · ${esc(ago(b.updated))}</span></div>
    <div class="sx-muted">${esc(b.message)}</div>
    ${links ? `<div>превью: ${links}</div>` : ''}
    <div>${b.pr ? prLine(b.pr) : `${badge('info', 'без PR')} <span class="sx-muted">проверить на превью → open_pull_request</span>`}</div>
  </div>`;
}

/** Решает ли человек за владельца: по справочнику гейтвея (owners), без него — сам владелец. */
export const decides = (actor: string | null, owner: string, owners?: string[]) => !!actor && (owners ? owners.includes(actor) : actor === owner);

export function deleteButton(action: string, field: string, value: string, label: string, question: string, owner: string, actor: string | null, owners?: string[]): string {
  if (!actor) return `<a class="sx-btn pt-del" href="/login" title="войдите, чтобы удалять">${esc(label)}</a>`;
  if (!decides(actor, owner, owners)) return `<button class="sx-btn pt-del" disabled title="удалить может только владелец: ${esc(owner)}">${esc(label)}</button>`;
  return `<form method="post" action="${action}" class="pt-inline" onsubmit="return confirm(${esc(JSON.stringify(question))})">
    <input type="hidden" name="${field}" value="${esc(value)}"><button class="sx-btn pt-del">${esc(label)}</button></form>`;
}

const PT_CSS = `.pt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; margin-bottom: 20px; }
.pt-tool { padding: 12px 14px; }
.pt-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.pt-head h2 { font-size: 16px; margin: 0; }
.pt-head a, .pt-tool a, .sx-header a { color: var(--accent); }
.pt-meta { margin: 6px 0 2px; }
.pt-sec { margin-top: 10px; }
.pt-sec > b { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.pt-bar { height: 6px; background: var(--border); border-radius: 3px; margin: 5px 0 3px; overflow: hidden; }
.pt-bar i { display: block; height: 100%; }
.pt-bar i.ok { background: var(--ok); } .pt-bar i.warn { background: var(--warn); } .pt-bar i.bad { background: var(--bad); }
.pt-branch { border-top: 1px solid var(--border); padding: 7px 0; }
.pt-branch:first-of-type { border-top: 0; padding-top: 0; }
h3 { font-size: 14px; margin: 18px 0 8px; }
code { font-size: 12px; }
details summary { cursor: pointer; }
.pt-inst { border: 1px solid var(--border); border-left-width: 3px; border-radius: 6px; padding: 8px 10px; margin-top: 10px; }
.pt-prod { border-left-color: var(--ok); }
.pt-preview { border-left-color: var(--info); background: var(--bg); }
.pt-inst-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 4px; }
.pt-inst-head .sx-badge { margin: 0; }
.pt-inline { display: inline; margin: 0 0 0 auto; }
.pt-del { font-size: 12px; padding: 2px 9px; margin-left: auto; text-decoration: none; }
.pt-del:not(:disabled) { color: var(--bad); border-color: var(--bad); }
.pt-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pt-nav { display: flex; gap: 4px; flex-wrap: wrap; margin: -4px 0 14px; }
.pt-nav a { padding: 5px 11px; border-radius: 6px; color: var(--text); text-decoration: none; border: 1px solid transparent; }
.pt-nav a.on { border-color: var(--border); background: var(--surface); font-weight: 600; }
.pt-search { width: 100%; max-width: 420px; padding: 8px 10px; font: inherit; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); }
.pt-desc { margin: 6px 0; }
.pt-actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.pt-read { grid-template-columns: 1fr; max-width: 62rem; }
.pt-read p, .pt-read li, .pt-read .sx-muted { max-width: 72ch; }
.pt-steps { margin: 8px 0 10px; padding-left: 20px; }
.pt-list.pt-defs li { display: grid; grid-template-columns: 1fr; gap: 2px; }
@media (min-width: 640px) { .pt-list.pt-defs li { grid-template-columns: 26ch 1fr; gap: 4px 14px; align-items: baseline; } }
.pt-steps li { padding: 4px 0; }
.pt-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px 16px; margin-top: 10px; }
.pt-facts > div { min-width: 0; overflow-wrap: anywhere; }
.pt-facts b { display: block; font-size: 12px; color: var(--muted); font-weight: 500; margin-bottom: 2px; }
.pt-list { list-style: none; margin: 0; padding: 0; }
.pt-list li { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; flex-wrap: wrap;
  padding: 5px 0; border-top: 1px solid var(--border); }
.pt-list li:first-child { border-top: 0; padding-top: 0; }
.pt-kv { display: grid; grid-template-columns: max-content 1fr; gap: 3px 12px; }
.pt-kv > span:nth-child(odd) { color: var(--muted); }
pre.pt-code { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
.pt-scroll { overflow-x: auto; }
.pt-scroll > .pt-table { min-width: 100%; width: max-content; }
.pt-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.pt-table td, .pt-table th { text-align: left; padding: 4px 6px; border-top: 1px solid var(--border); vertical-align: top; }
.pt-table th { color: var(--muted); font-weight: 500; border-top: 0; }
.pt-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.pt-dot.ok { background: var(--ok); } .pt-dot.bad { background: var(--bad); } .pt-dot.warn { background: var(--warn); }
`;

export type Section = 'catalog' | 'new-tool' | 'sources' | 'metrics' | 'platform' | 'dev' | 'inbox' | 'me' | 'admin';
const NAV: [Section, string, string][] = [
  ['catalog', '/', 'Каталог тулов'], ['new-tool', '/new-tool', 'Создать тул'], ['sources', '/sources', 'Источники'], ['metrics', '/metrics', 'Метрики'], ['platform', '/platform', 'Платформа'], ['dev', '/dev', 'Разработчику'],
];
/** Ссылки на кухню платформы главная подставляет сама — по правам человека, а не по странице. */
const INSIDER: Section[] = ['sources', 'platform', 'dev'];
export const INSIDER_MARK = '<!--insider-nav-->';

/** Сюда главная подставляет число непрочитанных после отрисовки: страницам не нужно знать о входящих. */
export const INBOX_MARK = '<!--inbox-count-->';
/** Ссылку на администрирование главная подставляет сама — страницы не знают, кто администратор. */
export const ADMIN_MARK = '<!--admin-link-->';

/** Общая раскладка страниц главной: шапка, навигация, вход (заглушка SSO), уведомления. */
export function layout(p: {
  title: string; active: Section | null; actor: string | null; body: string; lead?: string;
  notice?: string | null; problem?: string | null; errors?: Error[]; refresh?: number;
}): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${p.refresh ? `<meta http-equiv="refresh" content="${p.refresh}">` : ''}<title>${esc(p.title)} · Песочница тулов</title><style>${kitCss}
${PT_CSS}</style></head><body><div class="sx-page">
<div class="sx-header"><div><h1>${esc(p.title)}</h1>${p.lead ? `<p>${esc(p.lead)}</p>` : ''}</div>
<div class="sx-user">${p.actor ? `<a href="/me">${esc(p.actor)}</a>${ADMIN_MARK} · <a href="/logout">выйти</a>` : '<a href="/login">войти</a>'} · <a href="${GITEA_PUBLIC}/${REPO}">Gitea</a> · <a href="${GITEA_PUBLIC}/${REPO}/pulls">PR</a></div></div>
<nav class="pt-nav">${NAV.filter(([k]) => !INSIDER.includes(k)).map(([k, href, label]) => `<a href="${href}"${k === p.active ? ' class="on"' : ''}>${label}</a>`).join('')}${INSIDER_MARK}${NAV.filter(([k]) => INSIDER.includes(k)).map(([k, href, label]) => `<!--insider-start--><a href="${href}"${k === p.active ? ' class="on"' : ''}>${label}</a><!--insider-end-->`).join('')}${p.actor ? `<a href="/inbox"${p.active === 'inbox' ? ' class="on"' : ''}>Уведомления${INBOX_MARK}</a>` : ''}</nav>
${p.notice ? `<div class="sx-notice">${esc(p.notice)}</div>` : ''}${p.problem ? `<div class="sx-error">${esc(p.problem)}</div>` : ''}
${(p.errors ?? []).map((e) => `<div class="sx-error">${esc(e.message)}</div>`).join('')}
${p.body}
</div></body></html>`;
}
