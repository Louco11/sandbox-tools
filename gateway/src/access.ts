/**
 * Кому доступен тул (шаг Б4). Раньше любой вошедший видел все тулы; теперь у тула есть круг людей.
 *
 * Правила простые и проверяются на каждом вызове:
 *   - владелец (и тот, кто решает за него по справочнику) — всегда;
 *   - администратор песочницы — всегда: иначе некому разбирать брошенные тулы;
 *   - человек из группы доступа или из списка исключений — да;
 *   - канал mcp — только если тул разрешает подключение агентом;
 *   - превью ветки — не для всех групп тула, а для владельцев и одобряющих: это проверка, а не витрина.
 *
 * Источник правды — база: доступ меняют на главной без передеплоя, манифест задаёт начальное значение.
 */
import { service } from './db.ts';
import { ADMINS, APPROVERS } from '@sandbox/manifest';
import { ownersOf } from './directory.ts';
import { groupsOf } from './groups.ts';

export interface Access { tool: string; groups: string[]; people: string[]; agents: boolean; updated_at: Date; updated_by: string }

/** Имя тула из имени инстанса: превью <тул>--<ветка> наследует доступ прода. */
export const toolOf = (instance: string) => instance.split('--')[0]!;
export const isPreview = (instance: string) => instance.includes('--');

export async function accessOf(instance: string): Promise<Access | null> {
  const { rows } = await service.query<Access>('SELECT * FROM gateway.tool_access WHERE tool = $1', [toolOf(instance)]);
  return rows[0] ?? null;
}

/** Первый допуск тула: круг доступа берём из манифеста. Дальше манифест его не перезаписывает. */
export async function seedAccess(tool: string, want: { groups: string[]; people: string[]; agents: boolean }, by: string): Promise<string | null> {
  const current = await accessOf(tool);
  if (!current) {
    await service.query(
      'INSERT INTO gateway.tool_access (tool, groups, people, agents, updated_by) VALUES ($1, $2, $3, $4, $5)',
      [tool, want.groups, want.people, want.agents, by],
    );
    return null;
  }
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
  if (same(current.groups, want.groups) && same(current.people, want.people) && current.agents === want.agents) return null;
  // Расхождение — не ошибка выкатки: живой доступ менял человек, и он главнее манифеста. Но сказать об этом надо.
  return `доступ к «${tool}» в манифесте (${want.groups.join(', ') || 'только владелец'}) расходится с живым `
    + `(${current.groups.join(', ') || 'только владелец'}${current.people.length ? `, люди: ${current.people.join(', ')}` : ''}); `
    + 'действует живой — его меняли на главной';
}

export async function setAccess(tool: string, patch: { groups?: string[]; people?: string[]; agents?: boolean }, by: string): Promise<Access> {
  const { rows } = await service.query<Access>(
    `INSERT INTO gateway.tool_access (tool, groups, people, agents, updated_by)
     VALUES ($1, COALESCE($2::text[], '{}'), COALESCE($3::text[], '{}'), COALESCE($4::boolean, true), $5)
     ON CONFLICT (tool) DO UPDATE SET
       groups = COALESCE($2::text[], gateway.tool_access.groups),
       people = COALESCE($3::text[], gateway.tool_access.people),
       agents = COALESCE($4::boolean, gateway.tool_access.agents),
       updated_at = now(), updated_by = $5
     RETURNING *`,
    [tool, patch.groups ?? null, patch.people ?? null, patch.agents ?? null, by],
  );
  return rows[0]!;
}

export interface Who { actor: string; groups: string[]; channel: 'web' | 'mcp' }
export interface Verdict { allowed: boolean; reason: string; owner: string }

/**
 * Можно ли этому человеку пользоваться этим инстансом. Группы берём и из личности (IdP), и из песочницы:
 * вызов может прийти и от тула, который знает только логин.
 */
export async function canUse(instance: string, who: Who, owner: string): Promise<Verdict> {
  const groups = [...new Set([...who.groups, ...(await groupsOf(who.actor))])];
  const decides = ownersOf(owner).logins;
  const admin = groups.includes(ADMINS);
  const base = { owner };

  if (decides.includes(who.actor)) return { ...base, allowed: true, reason: 'владелец' };
  if (admin) return { ...base, allowed: true, reason: 'администратор песочницы' };

  if (isPreview(instance)) {
    // Превью — проверка перед мержем: его смотрят владелец и одобряющие, а не все, кому открыт прод.
    return groups.includes(APPROVERS)
      ? { ...base, allowed: true, reason: 'одобряющий' }
      : { ...base, allowed: false, reason: `превью ${instance} смотрят владелец (${owner}) и одобряющие` };
  }

  const access = await accessOf(instance);
  if (who.channel === 'mcp' && access && !access.agents) {
    return { ...base, allowed: false, reason: `тул ${toolOf(instance)} закрыт для агентов: владелец разрешил только веб-интерфейс` };
  }
  if (access?.people.includes(who.actor)) return { ...base, allowed: true, reason: 'личное исключение' };
  const hit = access?.groups.find((g) => groups.includes(g));
  if (hit) return { ...base, allowed: true, reason: `группа ${hit}` };

  const open = access?.groups.length ? `открыт группам: ${access.groups.join(', ')}` : 'открыт только владельцу';
  return { ...base, allowed: false, reason: `тул ${toolOf(instance)} ${open}. Попросите доступ у владельца: ${owner}` };
}

// ---------- заявки на доступ (П1) ----------------------------------------------------------------

export interface AccessRequest {
  id: number; tool: string; login: string; note: string | null;
  created_at: Date; status: 'pending' | 'granted' | 'denied'; decided_by: string | null; decided_at: Date | null;
}

/** Заявка — объект, а не письмо: владелец закрывает её одной кнопкой, проситель видит ответ. */
export async function requestAccess(tool: string, login: string, note: string): Promise<AccessRequest> {
  const { rows } = await service.query<AccessRequest>(
    `INSERT INTO gateway.access_requests (tool, login, note) VALUES ($1, $2, NULLIF($3, ''))
     ON CONFLICT (tool, login) WHERE status = 'pending'
     DO UPDATE SET note = COALESCE(NULLIF($3, ''), gateway.access_requests.note), created_at = now()
     RETURNING *`,
    [toolOf(tool), login, note.slice(0, 300)],
  );
  return rows[0]!;
}

export async function pendingRequests(tool: string): Promise<AccessRequest[]> {
  const { rows } = await service.query<AccessRequest>(
    `SELECT * FROM gateway.access_requests WHERE tool = $1 AND status = 'pending' ORDER BY created_at`,
    [toolOf(tool)],
  );
  return rows;
}

/** Заявки человека: чтобы не просить дважды и видеть ответ владельца. */
export async function myRequests(login: string): Promise<AccessRequest[]> {
  const { rows } = await service.query<AccessRequest>(
    `SELECT * FROM gateway.access_requests WHERE login = $1 AND (status = 'pending' OR decided_at > now() - interval '7 days')
      ORDER BY created_at DESC LIMIT 20`,
    [login],
  );
  return rows;
}

/** Решение владельца: «дать доступ» сразу добавляет человека в круг тула, «отказать» просто закрывает заявку. */
export async function decideRequest(id: number, decision: 'granted' | 'denied', by: string): Promise<AccessRequest | null> {
  const { rows } = await service.query<AccessRequest>(
    `UPDATE gateway.access_requests SET status = $2, decided_by = $3, decided_at = now()
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [id, decision, by],
  );
  const request = rows[0];
  if (!request) return null;
  if (decision === 'granted') {
    const current = await accessOf(request.tool);
    const people = [...new Set([...(current?.people ?? []), request.login])];
    await setAccess(request.tool, { people }, by);
  }
  return request;
}
