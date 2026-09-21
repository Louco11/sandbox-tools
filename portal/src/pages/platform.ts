/** /platform — здоровье песочницы: гейтвей и реестр, коннекторы источников, деплоер, уборщик, CI. */
import type { CiRun, Deploy, Platform } from '../data.ts';
import { ago, badge, esc, layout } from '../html.ts';

const dot = (ok: boolean) => `<span class="pt-dot ${ok ? 'ok' : 'bad'}"></span>`;
const SWEEP_LATE_MS = 3 * 60_000;

export function renderPlatform(p: {
  platform: Platform | Error; deployer: boolean; notifier: { messages: number } | null; deploys: Deploy[] | Error; runs: CiRun[] | Error; actor: string | null;
}): string {
  const errors = [p.platform, p.deploys, p.runs].filter((e): e is Error => e instanceof Error);
  const pl = p.platform instanceof Error ? null : p.platform;
  const sweep = pl?.reaper.last_sweep_at ?? null;
  const sweepOk = !!sweep && Date.now() - new Date(sweep).getTime() < SWEEP_LATE_MS;

  const gateway = `<div class="sx-card pt-tool"><div class="pt-head"><h2>${dot(!!pl)} Гейтвей и реестр</h2></div>
    ${pl ? `<div class="pt-kv"><span>реестр</span><span>${pl.registry.sources} источников, ${pl.registry.writes} прав записи · перечитан ${esc(ago(pl.registry.loaded_at))}</span>
      <span>справочник</span><span>${pl.directory.people} сотрудников-исключений, ${pl.directory.groups} групп · перечитан ${esc(ago(pl.directory.loaded_at))}</span>
      <span>тулы</span><span>${pl.tools.active} в проде · ${pl.tools.previews} превью · ${pl.tools.expiring} истекают ≤ 7 дн. · ${pl.tools.idle} в простое</span></div>
      ${pl.registry.reload_error ? `<div class="sx-error">правка реестра не принята, действует прежний: ${esc(pl.registry.reload_error)}</div>` : ''}
      ${pl.directory.error ? `<div class="sx-error">правка справочника не принята, действует прежний: ${esc(pl.directory.error)}</div>` : ''}` : '<div class="sx-error">гейтвей не отвечает</div>'}</div>`;

  const connectors = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Коннекторы источников</h2></div>
    ${pl ? `<table class="pt-table">${pl.connectors.map((c) => `<tr><td>${dot(c.ok && c.token)} <a href="/sources/${esc(c.source)}">${esc(c.source)}</a></td>
      <td>${c.ok ? `${c.ms} мс` : badge('bad', 'не отвечает')}${c.token ? '' : ` ${badge('bad', 'нет токена у гейтвея')}`}</td></tr>`).join('')}</table>` : '—'}</div>`;

  const deploys = p.deploys instanceof Error ? [] : p.deploys;
  const deployer = `<div class="sx-card pt-tool"><div class="pt-head"><h2>${dot(p.deployer)} Деплоер</h2><span class="sx-muted">выкатка после зелёного CI</span></div>
    ${deploys.length ? `<table class="pt-table">${deploys.slice(0, 8).map((d) => `<tr><td><code>${esc(d.sha.slice(0, 7))}</code></td><td>${esc(d.branch)}</td>
      <td>${badge(d.state === 'success' ? 'ok' : d.state === 'failure' ? 'bad' : 'warn', d.state)}</td><td class="sx-muted">${esc(ago(d.finished_at ?? d.started_at ?? null))}</td></tr>`).join('')}</table>` : '<div class="sx-muted">выкаток нет</div>'}</div>`;

  const reaper = `<div class="sx-card pt-tool"><div class="pt-head"><h2>${dot(sweepOk)} Уборщик</h2><span class="sx-muted">сроки жизни, простой, уборка истории</span></div>
    <div>${sweep ? `последний проход ${esc(ago(sweep))}` : 'проходов не было с запуска гейтвея'}${sweepOk ? '' : ` ${badge('bad', 'не работает — тулы не удаляются')}`}</div></div>`;

  const notifier = `<div class="sx-card pt-tool"><div class="pt-head"><h2>${dot(!!p.notifier)} Уведомления</h2><span class="sx-muted">канал: входящие на главной (заглушка)</span></div>
    <div>${p.notifier ? `${p.notifier.messages} сообщений за 90 дней` : badge('bad', 'не отвечает — владельцы не узнают о простое')}</div></div>`;

  const runs = p.runs instanceof Error ? [] : p.runs;
  const ci = `<div class="sx-card pt-tool"><div class="pt-head"><h2>CI</h2><span class="sx-muted">Gitea Actions</span></div>
    ${runs.length ? `<table class="pt-table">${runs.map((r) => `<tr><td>#${r.run_number}</td><td>${esc(r.head_branch)}</td>
      <td>${badge(r.status === 'success' ? 'ok' : r.status === 'failure' ? 'bad' : 'warn', r.status)}</td><td class="sx-muted">${esc(ago(r.updated_at ?? null))}</td></tr>`).join('')}</table>` : '<div class="sx-muted">запусков нет</div>'}</div>`;

  return layout({
    title: 'Платформа', active: 'platform', actor: p.actor, errors, refresh: 30,
    lead: 'Состояние песочницы: всё, от чего зависят тулы',
    body: `<div class="pt-grid">${gateway}${connectors}${deployer}${reaper}${notifier}${ci}</div>`,
  });
}
