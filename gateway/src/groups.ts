/**
 * Группы песочницы (шаг Б3). Их заводит администратор под задачу: «Кондитерская — склад», «Пилот продаж».
 * Группы из IdP сюда не копируются — они приходят в подписанной личности и живут в IdP; здесь только то,
 * чем управляет сама песочница.
 *
 * Решение о правах принимает гейтвей: изменения идут только через его API с проверкой роли, каждое — в аудит.
 * Участие может быть срочным (до конца пилота): просроченное членство не действует, ничего вычищать не нужно.
 */
import { service } from './db.ts';
import { ADMINS, APPROVERS } from '@sandbox/manifest';
import { HttpError, badRequest } from './errors.ts';

export interface Group { name: string; title: string; created_at: Date; created_by: string; members: Member[] }
export interface Member { login: string; added_at: Date; added_by: string; expires_at: Date | null }

const NAME = /^[a-z][a-z0-9-]{1,63}$/;

export async function listGroups(): Promise<Group[]> {
  const { rows } = await service.query<Group & { members: Member[] | null }>(
    `SELECT g.name, g.title, g.created_at, g.created_by,
            COALESCE(json_agg(json_build_object('login', m.login, 'added_at', m.added_at, 'added_by', m.added_by,
                                                'expires_at', m.expires_at) ORDER BY m.login)
                     FILTER (WHERE m.login IS NOT NULL), '[]') AS members
       FROM gateway.groups g LEFT JOIN gateway.group_members m ON m.group_name = g.name
      GROUP BY g.name ORDER BY g.name`,
  );
  return rows.map((r) => ({ ...r, members: r.members ?? [] }));
}

/** Группы песочницы, в которых человек состоит прямо сейчас: просроченное участие не считается. */
export async function groupsOf(login: string): Promise<string[]> {
  const { rows } = await service.query<{ group_name: string }>(
    `SELECT group_name FROM gateway.group_members
      WHERE login = $1 AND (expires_at IS NULL OR expires_at > now()) ORDER BY group_name`,
    [login],
  );
  return rows.map((r) => r.group_name);
}

export async function createGroup(p: { name: string; title: string; by: string }): Promise<Group> {
  if (!NAME.test(p.name)) throw badRequest('имя группы: латиница, цифры, дефис, от двух символов');
  if (p.name === ADMINS || p.name === APPROVERS) throw badRequest(`${p.name} — роль песочницы, её состав задаёт IdP`);
  await service.query('INSERT INTO gateway.groups (name, title, created_by) VALUES ($1, $2, $3)', [p.name, p.title.slice(0, 120) || p.name, p.by])
    .catch((e: { code?: string }) => {
      if (e.code === '23505') throw new HttpError(409, 'conflict', `группа ${p.name} уже есть`);
      throw e;
    });
  return (await listGroups()).find((g) => g.name === p.name)!;
}

export async function removeGroup(name: string): Promise<boolean> {
  const { rowCount } = await service.query('DELETE FROM gateway.groups WHERE name = $1', [name]);
  return Boolean(rowCount);
}

export async function addMember(p: { group: string; login: string; by: string; expiresAt: Date | null }): Promise<void> {
  await service.query(
    `INSERT INTO gateway.group_members (group_name, login, added_by, expires_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (group_name, login) DO UPDATE SET added_by = EXCLUDED.added_by, added_at = now(), expires_at = EXCLUDED.expires_at`,
    [p.group, p.login, p.by, p.expiresAt],
  );
}

export async function removeMember(group: string, login: string): Promise<boolean> {
  const { rowCount } = await service.query('DELETE FROM gateway.group_members WHERE group_name = $1 AND login = $2', [group, login]);
  return Boolean(rowCount);
}

/** Журнал изменений групп и ключей — из общего аудита: кто что менял и почему. */
export async function groupJournal(limit = 40) {
  const { rows } = await service.query<{ at: Date; actor: string; operation: string; allowed: boolean; reason: string | null }>(
    `SELECT at, actor, operation, allowed, reason FROM audit.calls
      WHERE operation LIKE 'group.%' OR operation LIKE 'key.%' ORDER BY id DESC LIMIT $1`,
    [Math.min(200, limit)],
  );
  return rows;
}
