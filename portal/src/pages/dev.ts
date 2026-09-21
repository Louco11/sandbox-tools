/** /dev — разработчику: тулы с превью и ветками, PR, изменения каркаса, рабочая копия стенда. */
import { DOMAIN, GITEA_PUBLIC, REPO, TOOL_URL } from '../config.ts';
import { branchSlug, NEUTRAL, type GatewayTool, type Local, type Manifest, type repoState } from '../data.ts';
import { removalBranch } from '../actions.ts';
import { ago, badge, branchLine, days, deleteButton, esc, layout, lifetime, prLine } from '../html.ts';

export function render(data: {
  gw: GatewayTool[] | Error; main: Map<string, Manifest> | Error;
  repo: Awaited<ReturnType<typeof repoState>> | Error; local: Local | Error;
  actor: string | null; notice: string | null; problem: string | null;
}): string {
  const gw = data.gw instanceof Error ? [] : data.gw;
  const main = data.main instanceof Error ? new Map<string, Manifest>() : data.main;
  const repo = data.repo instanceof Error ? { branches: [], merged: [], pulls: [] } : data.repo;
  const errors = [data.gw, data.main, data.repo, data.local].filter((e): e is Error => e instanceof Error);

  const prod = new Map(gw.filter((t) => !t.name.includes('--')).map((t) => [t.name, t]));
  const previewsOf = (tool: string) => gw.filter((t) => t.name.startsWith(`${tool}--`));
  const branchesOf = (tool: string) => repo.branches.filter((b) => b.tools.includes(tool));
  const inBranches = new Set(repo.branches.flatMap((b) => b.tools));
  const names = [...new Set([...main.keys(), ...inBranches])].sort();
  // Регистрации в гейтвее без кода ни в main, ни в ветках — например, после make demo-gateway.
  const orphans = [...prod.values()].filter((t) => !main.has(t.name) && !inBranches.has(t.name));
  const frameworkBranches = repo.branches.filter((b) => b.framework.length > 0);

  const alive = [...prod.values()].filter((t) => main.has(t.name) && !t.revoked_at && days(t.expires_at) > 0);
  const stats = [
    ['тулов в проде', alive.length],
    ['истекает ≤ 7 дней', alive.filter((t) => days(t.expires_at) <= 7 || t.idle_notified_at).length],
    ['превью', gw.filter((t) => t.name.includes('--') && !t.revoked_at && days(t.expires_at) > 0).length],
    ['веток с изменениями', repo.branches.length],
    ['открытых PR', repo.pulls.length],
    ['ждут одобрения', repo.pulls.filter((p) => !p.approvedBy.length).length],
  ];

  const removalPr = (tool: string) => repo.pulls.find((p) => p.head === removalBranch(tool)) ?? null;
  const branchOfPreview = (instance: string) => {
    const slug = instance.slice(instance.indexOf('--') + 2);
    const tool = instance.slice(0, instance.indexOf('--'));
    const name = slug === 'preview' ? `preview/${tool}` : null;
    const active = repo.branches.find((b) => (name ? b.name === name : branchSlug(b.name) === slug));
    if (active) return `<code>${esc(active.name)}</code>`;
    const merged = repo.merged.find((b) => (name ? b === name : branchSlug(b) === slug));
    if (merged) return `<code>${esc(merged)}</code> ${badge('ok', 'влита в main', 'превью больше не нужно — можно удалить')}`;
    return `<code>${esc(name ?? `…${slug}`)}</code> ${badge('info', 'ветки нет', 'ветка удалена — превью устарело')}`;
  };

  const prodBlock = (name: string, m: Manifest | undefined, t: GatewayTool | undefined, owner: string) => {
    const alive = t && !t.revoked_at && days(t.expires_at) > 0;
    const pr = removalPr(name);
    const head = `<div class="pt-inst-head">${badge('ok', 'ПРОД')} ${alive ? `<a href="${TOOL_URL(name)}">${esc(name)}.${DOMAIN}</a>` : `<span class="sx-muted">${esc(name)}</span>`}
      ${alive ? deleteButton('/revoke', 'instance', name, 'Удалить', `Удалить прод-инстанс ${name}? Контейнер удалится в течение минуты, данные в источниках останутся.`, owner, data.actor, t?.owners) : ''}</div>`;
    let body: string;
    if (!t) body = `<div class="sx-muted">${m ? 'ещё не выкачен — CI выкатит при следующем прогоне main' : 'появится после мержа PR с тулом'}</div>`;
    else body = lifetime(t);
    let removal = '';
    if (m && t && (t.revoked_at || days(t.expires_at) <= 0)) {
      removal = pr
        ? `<div class="pt-sec">Удаление кода: ${prLine(pr)}</div>`
        : `<div class="pt-sec pt-row"><span class="sx-muted">Инстанс удалён, код ещё в main.</span>
            ${deleteButton('/remove-code', 'tool', name, 'Убрать код из main → PR', `Открыть PR, удаляющий tools/${name} из main? Мержить будете вы.`, owner, data.actor, t?.owners)}</div>`;
    } else if (m && pr) removal = `<div class="pt-sec">Удаление кода: ${prLine(pr)}</div>`;
    return `<div class="pt-inst pt-prod">${head}${body}${removal}</div>`;
  };

  const previewBlock = (p: GatewayTool) => `<div class="pt-inst pt-preview">
    <div class="pt-inst-head">${badge('info', 'ПРЕВЬЮ')} <a href="${TOOL_URL(p.name)}">${esc(p.name)}.${DOMAIN}</a>
      ${deleteButton('/revoke', 'instance', p.name, 'Удалить', `Удалить превью ${p.name}? Новый пуш ветки поднимет его снова.`, p.owner, data.actor, p.owners)}</div>
    <div class="sx-muted">ветка ${branchOfPreview(p.name)} · ещё ${days(p.expires_at)} дн. · без автопродления · заход человека: ${esc(ago(p.last_human_at))}</div>
  </div>`;

  const cards = names.map((name) => {
    const m = main.get(name);
    const t = prod.get(name);
    const branches = branchesOf(name);
    const where = m ? '' : badge('warn', 'только в ветке', 'тула ещё нет в main — появится после мержа PR');
    const owner = m?.owner ?? t?.owner ?? previewsOf(name)[0]?.owner ?? '—';
    return `<div class="sx-card pt-tool">
      <div class="pt-head">
        <h2>${t && !t.revoked_at ? `<a href="${TOOL_URL(name)}">${esc(name)}</a>` : esc(name)} ${where}</h2>
        <span class="sx-muted">владелец ${esc(owner)}</span>
      </div>
      <div class="pt-meta">
        ${(m?.sources ?? t?.sources ?? []).map((s) => badge('info', s, 'источник')).join('')}
        ${(m?.writes ?? t?.writes ?? []).map((w) => badge('warn', `✎ ${w}`, 'право записи')).join('')}
      </div>
      ${prodBlock(name, m, t, owner)}
      ${previewsOf(name).filter((p) => !p.revoked_at && days(p.expires_at) > 0).map((p) => previewBlock(p)).join('')}
      <div class="pt-sec"><b>Изменения в ветках · ${branches.length}</b>${branches.length ? branches.map((b) => branchLine(b, previewsOf(name))).join('') : '<div class="sx-muted">нет — всё в main</div>'}</div>
    </div>`;
  }).join('');

  let localHtml = '';
  if (data.local instanceof Error) localHtml = `<div class="sx-error">рабочая копия: ${esc(data.local.message)}</div>`;
  else {
    const l = data.local;
    const groups = new Map<string, typeof l.files>();
    for (const f of l.files) {
      const key = f.path.match(/^tools\/([^/]+)\//)?.[1] ?? (NEUTRAL.has(f.path) ? 'служебные файлы' : 'каркас');
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    localHtml = `<div class="sx-card pt-tool">
      <div class="pt-head"><h2>Рабочая копия на стенде</h2><span class="sx-muted">ветка <code>${esc(l.branch)}</code></span></div>
      <div class="pt-sec"><b>Незакоммиченные изменения · ${l.files.length}</b>${l.files.length ? [...groups].map(([g, fs]) =>
        `<details><summary>${esc(g)} <span class="sx-muted">${fs.length} файл.</span></summary>${fs.map((f) => `<div><code>${esc(f.status)}</code> ${esc(f.path)}</div>`).join('')}</details>`).join('') : '<div class="sx-muted">нет — всё закоммичено</div>'}</div>
      <div class="pt-sec"><b>Незапушенные коммиты</b>${l.unpushed.length ? l.unpushed.map((u) => `<div><code>${esc(u.branch)}</code> — ${u.commits} коммит.</div>`).join('') : '<div class="sx-muted">нет</div>'}</div>
      ${l.worktrees.length ? `<div class="pt-sec"><b>Дополнительные worktree</b>${l.worktrees.map((w) => `<div><code>${esc(w.branch)}</code> <span class="sx-muted">${esc(w.path)}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }

  return layout({
    title: 'Разработчику', active: 'dev', actor: data.actor, notice: data.notice, problem: data.problem, errors, refresh: 30,
    lead: 'Тулы с превью и ветками, PR, изменения каркаса, рабочая копия стенда · обновляется каждые 30 с',
    body: `<div class="sx-stats">${stats.map(([l, v]) => `<div class="sx-stat"><b>${v}</b><span>${l}</span></div>`).join('')}</div>
<h3>Тулы</h3><div class="pt-grid">${cards || '<div class="sx-card sx-empty">Тулов пока нет</div>'}</div>
<h3>Каркас</h3><div class="pt-grid"><div class="sx-card pt-tool">
  <div class="pt-head"><h2>Изменения каркаса в ветках · ${frameworkBranches.length}</h2></div>
  ${frameworkBranches.length ? frameworkBranches.map((b) => branchLine(b, gw) + `<details><summary class="sx-muted">файлы каркаса: ${b.framework.length}</summary>${b.framework.map((f) => `<div><code>${esc(f)}</code></div>`).join('')}</details>`).join('') : '<div class="sx-muted">нет</div>'}
  ${orphans.length ? `<div class="pt-sec"><b>Регистрации в гейтвее без кода · ${orphans.length}</b><div class="sx-muted">${orphans
    .map((o) => `${esc(o.name)} (${o.revoked_at ? 'отозван' : `ещё ${days(o.expires_at)} дн.`})`).join(', ')} — остались от демо; уборщик удалит по сроку</div></div>` : ''}
  ${repo.merged.length ? `<div class="pt-sec"><b>Ветки без отличий от main (влиты или устарели)</b><div class="sx-muted">${repo.merged.map(esc).join(', ')}</div></div>` : ''}
</div>${localHtml}</div>`,
  });
}

