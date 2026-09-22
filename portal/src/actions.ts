/**
 * Действия владельца на главной. Кто решает за владельца (он сам, руководитель ушедшего, участник группы), проверяет
 * гейтвей по справочнику — здесь только понятная ошибка заранее. Личность до шага Б1 — заглушка SSO главной.
 * В гейтвей — токеном роли portal и подписанной личностью человека (X-Sandbox-Identity), в аудит — от его имени.
 */
import { render as renderAgentConfigs } from '../../infra/agents/sync.ts';
import { GATEWAY_URL, PORTAL_TOKEN } from './config.ts';
import { forgeAs, gatewayTools, gitea, mainTools } from './data.ts';

/** Заголовки решения человека: токен роли главной плюс его подписанная личность, как её выдал identity. */
const asPerson = (actor: Person, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${PORTAL_TOKEN}`,
  ...(actor.identity ? { 'X-Sandbox-Identity': actor.identity } : { 'X-Actor': actor.login }),
  ...extra,
});

/** Человек за кнопкой: логин для сообщений и его личность для гейтвея. */
export interface Person { login: string; identity: string | null }

export const removalBranch = (tool: string) => `remove/${tool}`;

/** Отзыв инстанса (прод или превью): гейтвей сразу отвечает 403, уборщик удаляет контейнер. Только владелец. */
export async function revokeInstance(actor: Person, instance: string): Promise<string> {
  const t = (await gatewayTools()).find((x) => x.name === instance);
  if (!t) throw new Error(`инстанс ${instance} не найден`);
  if (!t.owners.includes(actor.login)) throw new Error(`удалить ${instance} может только владелец (${t.owner}${t.owner_note ? `: ${t.owner_note}` : ''}), а не ${actor.login}`);
  if (t.revoked_at) return `${instance} уже отозван`;
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools/${encodeURIComponent(instance)}/revoke`, {
    method: 'POST', headers: asPerson(actor),
  });
  if (!res.ok) throw new Error(`гейтвей: ${res.status} ${await res.text()}`);
  const preview = instance.includes('--');
  return preview
    ? `Превью ${instance} отозвано; уборщик удалит контейнер в течение минуты. Новый пуш ветки поднимет его снова.`
    : `Прод-инстанс ${instance} отозван; уборщик удалит контейнер в течение минуты. Код тула ещё в main — уберите его PR.`;
}

export interface TreeEntry { path: string; type: string; sha: string }

/**
 * PR, убирающий тул из main: одним коммитом удаляет tools/<тул>, чистит package-lock и пересобирает
 * конфиги агентов. Коммит и PR — от бота того, кто нажал кнопку (`<логин>-agent`), а не общей учётной
 * записью: в истории репозитория видно, чьё это решение. Мержит, как обычно, человек после одобрения.
 */
export async function openRemovalPr(actor: Person, tool: string): Promise<string> {
  const main = await mainTools();
  const m = main.get(tool);
  if (!m) throw new Error(`тула ${tool} нет в main`);
  const owners = (await gatewayTools()).find((x) => x.name === tool)?.owners ?? [m.owner];
  if (!owners.includes(actor.login)) throw new Error(`убрать ${tool} из main может только владелец (${m.owner}), а не ${actor.login}`);
  const branch = removalBranch(tool);
  const exists = await gitea(`/branches/${encodeURIComponent(branch)}`).then(() => true, () => false);
  if (exists) throw new Error(`ветка ${branch} уже есть — PR на удаление открыт или не влит`);

  const tree = await gitea<{ tree: TreeEntry[]; truncated: boolean }>('/git/trees/main?recursive=true&per_page=10000');
  if (tree.truncated) throw new Error('дерево main слишком большое для одного запроса');
  const files: Record<string, unknown>[] = tree.tree
    .filter((e) => e.type === 'blob' && e.path.startsWith(`tools/${tool}/`))
    .map((e) => ({ operation: 'delete', path: e.path, sha: e.sha }));

  const read = async (path: string) => {
    const f = await gitea<{ content: string; sha: string }>(`/contents/${path}?ref=main`);
    return { text: Buffer.from(f.content, 'base64').toString('utf8'), sha: f.sha };
  };
  const update = (path: string, sha: string, text: string) =>
    files.push({ operation: 'update', path, sha, content: Buffer.from(text).toString('base64') });

  const lock = await read('package-lock.json');
  const lockJson = JSON.parse(lock.text) as { packages: Record<string, { resolved?: string; link?: boolean }> };
  for (const [k, v] of Object.entries(lockJson.packages)) {
    if (k === `tools/${tool}` || (k.startsWith('node_modules/') && v.link && v.resolved === `tools/${tool}`)) delete lockJson.packages[k];
  }
  update('package-lock.json', lock.sha, `${JSON.stringify(lockJson, null, 2)}\n`);

  const rest = [...main.keys()].filter((t) => t !== tool).sort();
  const configs = renderAgentConfigs([{ name: 'sandbox', args: ['platform'] }, ...rest.map((t) => ({ name: `sandbox-${t}`, args: ['tool', t] }))]);
  for (const [path, content] of Object.entries(configs)) {
    const cur = await read(path).catch(() => null);
    if (cur) update(path, cur.sha, `${JSON.stringify(content, null, 2)}\n`);
  }

  if (!actor.identity) throw new Error('нет подписанной личности — войдите заново');
  const auth = await forgeAs(actor.identity);
  await gitea('/contents', {
    method: 'POST', auth,
    body: { branch: 'main', new_branch: branch, message: `Удалить тул ${tool}\n\nПо решению владельца ${actor} (главная страница песочницы).`, files },
  });
  const pr = await gitea<{ number: number; html_url: string }>('/pulls', {
    method: 'POST', auth,
    body: {
      head: branch, base: 'main', title: `Удалить тул ${tool}`,
      body: `Владелец **${actor}** удаляет тул \`${tool}\` с главной страницы песочницы.\n\nУбирается \`tools/${tool}/\`, его записи в \`package-lock.json\` и MCP-сервер \`sandbox-${tool}\` из конфигов агентов. Данные в источниках не затрагиваются.\n\nОткрыто ботом владельца по его решению на главной. Мерж — после одобрения человеком и зелёного CI.`,
    },
  });
  return `Открыт PR #${pr.number} на удаление кода ${tool} из main: ${pr.html_url}`;
}

/** Явное продление владельцем — на ttl_days тула, не дальше потолка реестра (его держит гейтвей). */
export async function extendInstance(actor: Person, instance: string): Promise<string> {
  const t = (await gatewayTools()).find((x) => x.name === instance);
  if (!t) throw new Error(`инстанс ${instance} не найден`);
  if (!t.owners.includes(actor.login)) throw new Error(`продлить ${instance} может только владелец (${t.owner}${t.owner_note ? `: ${t.owner_note}` : ''}), а не ${actor.login}`);
  if (t.revoked_at) throw new Error(`${instance} отозван — продлить нельзя`);
  const days = (await mainTools()).get(instance)?.ttl_days ?? 30;
  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools/${encodeURIComponent(instance)}/extend`, {
    method: 'POST', headers: asPerson(actor, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ days }),
  });
  if (!res.ok) throw new Error(`гейтвей: ${res.status} ${await res.text()}`);
  const { expires_at } = (await res.json()) as { expires_at: string };
  return `${instance} продлён до ${new Date(expires_at).toLocaleDateString('ru-RU')}`;
}
