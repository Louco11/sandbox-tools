import type { Manifest } from '@sandbox/manifest';

/** Кто и через что обращается. Каждый вызов к данным идёт с таким контекстом и попадает в аудит. */
export interface CallContext {
  requestId: string;
  tool: string;
  manifest: Manifest;
  /** Живой человек, от имени которого идёт вызов: логин из подписанной личности. */
  actor: string;
  /** Его группы — из IdP и из песочницы. По ним решаются поля, строки и права записи (шаг Б5). */
  groups: string[];
  /** Имя агента, если агент участвует в цепочке решения. null — только человек. */
  agent: string | null;
}

const ACTOR = /^[a-z][a-z0-9._-]{1,63}$/;

export function parseActor(raw: string | undefined): string | null {
  return raw && ACTOR.test(raw) ? raw : null;
}
