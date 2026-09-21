/**
 * Личность вызова (шаг Б1). Гейтвей не верит ни туду, ни клиенту на слово: человек приходит подписанным JWT,
 * который выдал сервис identity после входа в IdP. Проверяются подпись, издатель, срок и aud — имя ровно того
 * инстанса, куда идёт запрос: личность, выданная для одного тула, в другом не работает.
 *
 * До шага Б1.2 у MCP-канала личности ещё нет: там остаётся заголовок X-Actor (заглушка), и это видно в аудите.
 */
import { createRemoteJWKSet, jwtVerify } from 'jose';

const JWKS_URL = process.env.IDENTITY_JWKS_URL ?? 'http://identity:8080/jwks.json';
const ISSUER = process.env.IDENTITY_ISSUER ?? `http://id.${process.env.SANDBOX_DOMAIN ?? 'tools.localhost'}:18000/`;
const LOGIN = /^[a-z][a-z0-9._-]{1,63}$/;

const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export interface Identity {
  actor: string;
  groups: string[];
  /** web — человек в браузере; mcp — человек в хосте агента (Б1.2). */
  channel: 'web' | 'mcp';
}

export const HEADER = 'x-sandbox-identity';

/** Проверенная личность или null, если заголовка нет. Подделка и чужой aud — ошибка, а не null. */
export async function identityOf(raw: string | undefined, audience: string): Promise<Identity | null> {
  if (!raw) return null;
  const { payload } = await jwtVerify(raw, jwks, { issuer: ISSUER, audience });
  const actor = String(payload.sub ?? '');
  if (!LOGIN.test(actor)) throw new Error('в личности нет логина');
  const channel = payload.channel === 'mcp' ? 'mcp' : 'web';
  return { actor, groups: Array.isArray(payload.groups) ? (payload.groups as string[]) : [], channel };
}
