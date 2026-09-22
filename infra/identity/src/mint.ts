/**
 * Подписать личность ключом этого сервиса — для демо и проверок стенда:
 *   docker compose exec -T identity node infra/identity/src/mint.ts <логин> <инстанс> [срок] [канал]
 *
 * Это дверь в обход входа: подписанную личность получает любой, у кого есть доступ к контейнеру, — то есть
 * хозяин стенда. Снаружи её нет. Но раз она есть, она не должна быть бесшумной:
 *   * каждый выпуск пишется в аудит (`identity.mint`) — видно, что вход был не через IdP;
 *   * дверь закрывается `IDENTITY_ALLOW_MINT=0` — тогда остаётся только настоящий вход (и демо не работают).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT, importPKCS8 } from 'jose';
import { auditKey } from './keys.ts';

const [sub, aud, ttl = '2m', channel = 'web', groups = ''] = process.argv.slice(2);
if (!sub || !aud) {
  console.error('usage: node infra/identity/src/mint.ts <логин> <инстанс|portal> [срок] [web|mcp] [группы через запятую]');
  process.exit(2);
}
if (process.env.IDENTITY_ALLOW_MINT === '0') {
  console.error(
    'подпись личности в обход входа выключена (IDENTITY_ALLOW_MINT=0).\n'
    + 'Войдите по-настоящему: человек — в браузере, агент — bin/sandbox-mcp login.',
  );
  process.exit(3);
}

const domain = process.env.SANDBOX_DOMAIN ?? 'tools.localhost';
const key = await importPKCS8(readFileSync(join(process.env.STATE_DIR ?? '/state', 'identity-key.pem'), 'utf8'), 'RS256');
// В аудит — до выдачи: личность, выписанная так, должна быть видна, даже если дальше ею воспользовались.
await auditKey({
  actor: sub,
  operation: 'identity.mint',
  allowed: true,
  tool: aud,
  reason: `личность подписана в обход входа (mint.ts): инстанс ${aud}, канал ${channel}, срок ${ttl}`
    + (groups ? `, группы ${groups}` : ''),
}).catch(() => undefined);

console.log(await new SignJWT({ sub, groups: groups ? groups.split(',').filter(Boolean) : [], channel })
  .setProtectedHeader({ alg: 'RS256', kid: 'identity' })
  .setIssuer(`http://id.${domain}:${process.env.SANDBOX_PUBLIC_PORT ?? '18000'}/`)
  .setAudience(aud)
  .setIssuedAt()
  .setExpirationTime(ttl)
  .sign(key));
