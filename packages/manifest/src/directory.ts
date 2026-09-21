/**
 * Справочник сотрудников — заглушка HR/IdP до шага Б1. Хранит только исключения: кто ушёл из компании, кто чей
 * руководитель, какие есть группы. Логин, которого нет в справочнике, считается действующим сотрудником.
 *
 * Отсюда одно правило «кто решает за владельца тула»:
 *   - владелец-человек работает — он сам;
 *   - ушёл — его руководитель (вверх по цепочке до первого работающего);
 *   - владелец-группа (очередь поддержки) — её работающие участники;
 *   - никого не нашлось — тул ничей: сразу в простой, уведомление администраторам песочницы.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const login = z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/, 'логин: латиница, цифры, точка, дефис');

export const directorySchema = z.object({
  version: z.literal(1),
  people: z.record(login, z.object({
    name: z.string().optional(),
    email: z.string().email().optional(),
    manager: login.nullable().optional(),
    active: z.boolean().default(true),
  })).default({}),
  groups: z.record(login, z.object({
    title: z.string().optional(),
    members: z.array(login).default([]),
  })).default({}),
}).superRefine((d, ctx) => {
  for (const g of Object.keys(d.groups)) {
    if (d.people[g]) ctx.addIssue({ code: 'custom', path: ['groups', g], message: `имя ${g} занято человеком` });
  }
});
export type Directory = z.infer<typeof directorySchema>;

/** Администраторы и одобряющие песочницы — группы с этими именами. Человек стенда в них входит всегда. */
export const ADMINS = 'sandbox-admins';
export const APPROVERS = 'sandbox-approvers';

export function parseDirectory(text: string, human?: string): Directory {
  const dir = directorySchema.parse(parse(text) ?? { version: 1 });
  if (human) {
    for (const g of [ADMINS, APPROVERS]) {
      const group = (dir.groups[g] ??= { members: [] });
      if (!group.members.includes(human)) group.members.push(human);
    }
  }
  return dir;
}

/** Файла нет — пустой справочник: все логины считаются работающими, групп нет, кроме администраторов стенда. */
export function loadDirectory(path: string, human?: string): Directory {
  return parseDirectory(existsSync(path) ? readFileSync(path, 'utf8') : 'version: 1', human);
}

export interface Resolved {
  /** Кто получает уведомления и может решать за владельца. */
  logins: string[];
  kind: 'person' | 'group' | 'departed' | 'orphan' | 'unknown';
  /** Пояснение для человека: почему решает не тот, кто записан владельцем. */
  note: string | null;
}

const isActive = (dir: Directory, who: string) => dir.people[who]?.active !== false;

/** Логин, группа или e-mail (автор коммита) → кто на самом деле решает и получает уведомления. */
export function resolve(dir: Directory, name: string): Resolved {
  if (name.includes('@')) {
    const hit = Object.entries(dir.people).find(([, p]) => p.email?.toLowerCase() === name.toLowerCase());
    return hit ? resolve(dir, hit[0]) : { logins: [], kind: 'unknown', note: `адрес ${name} не найден в справочнике` };
  }
  const group = dir.groups[name];
  if (group) {
    const logins = [...new Set(group.members.filter((m) => isActive(dir, m)))];
    return logins.length
      ? { logins, kind: 'group', note: null }
      : { logins: [], kind: 'orphan', note: `в группе ${name} не осталось работающих сотрудников` };
  }
  if (isActive(dir, name)) return { logins: [name], kind: 'person', note: null };

  const seen = new Set([name]);
  let m = dir.people[name]?.manager ?? null;
  while (m && !seen.has(m)) {
    if (isActive(dir, m)) return { logins: [m], kind: 'departed', note: `${name} не работает в компании — решения за руководителем ${m}` };
    seen.add(m);
    m = dir.people[m]?.manager ?? null;
  }
  return { logins: [], kind: 'orphan', note: `${name} не работает в компании, работающего руководителя нет` };
}
