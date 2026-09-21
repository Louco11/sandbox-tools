/**
 * Справочник сотрудников в гейтвее: кто решает за владельца тула (продлить, удалить) и кому слать уведомления.
 * Файл — заглушка HR/IdP (registry/directory.yaml), перечитывается без рестарта; сломанный не применяется.
 * Человек стенда (SANDBOX_HUMAN) всегда в sandbox-admins и sandbox-approvers.
 */
import { statSync } from 'node:fs';
import { ADMINS, loadDirectory, resolve, type Directory, type Resolved } from '@sandbox/manifest';

export const DIRECTORY_PATH = process.env.DIRECTORY_PATH ?? '/registry/directory.yaml';
const HUMAN = process.env.SANDBOX_HUMAN || undefined;

let directory: Directory = loadDirectory(DIRECTORY_PATH, HUMAN);
export const directoryState = { loaded_at: new Date(), error: null as string | null };

const mtime = () => {
  try {
    return statSync(DIRECTORY_PATH).mtimeMs;
  } catch {
    return 0;
  }
};
let seen = mtime();
setInterval(() => {
  const m = mtime();
  if (m === seen) return;
  seen = m;
  try {
    directory = loadDirectory(DIRECTORY_PATH, HUMAN);
    directoryState.loaded_at = new Date();
    directoryState.error = null;
    console.log(JSON.stringify({ type: 'directory_reloaded', people: Object.keys(directory.people).length, groups: Object.keys(directory.groups) }));
  } catch (e) {
    directoryState.error = (e as Error).message;
    console.error(JSON.stringify({ type: 'directory_rejected', error: directoryState.error }));
  }
}, Number(process.env.REGISTRY_POLL_MS ?? 3000));

export const resolveName = (name: string): Resolved => resolve(directory, name);

/** Кто решает за владельца тула. Ничей тул — за администраторами песочницы, пока его не удалит простой. */
export function ownersOf(owner: string): Resolved {
  const r = resolve(directory, owner);
  if (r.kind !== 'orphan') return r;
  return { ...r, logins: resolve(directory, ADMINS).logins, note: `${r.note}; тул в простое, решают администраторы песочницы` };
}

export function directorySummary() {
  return { ...directoryState, people: Object.keys(directory.people).length, groups: Object.keys(directory.groups).length };
}
