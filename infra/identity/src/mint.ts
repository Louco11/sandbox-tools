/**
 * Подписать личность ключом этого сервиса — для демо и проверок стенда:
 *   docker compose exec -T identity node infra/identity/src/mint.ts <логин> <инстанс> [срок] [канал]
 * Наружу этого нет: нужен доступ к контейнеру, то есть к самому стенду.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SignJWT, importPKCS8 } from 'jose';

const [sub, aud, ttl = '2m', channel = 'web', groups = ''] = process.argv.slice(2);
if (!sub || !aud) {
  console.error('usage: node infra/identity/src/mint.ts <логин> <инстанс|portal> [срок] [web|mcp] [группы через запятую]');
  process.exit(2);
}
const domain = process.env.SANDBOX_DOMAIN ?? 'tools.localhost';
const key = await importPKCS8(readFileSync(join(process.env.STATE_DIR ?? '/state', 'identity-key.pem'), 'utf8'), 'RS256');
console.log(await new SignJWT({ sub, groups: groups ? groups.split(',').filter(Boolean) : [], channel })
  .setProtectedHeader({ alg: 'RS256', kid: 'identity' })
  .setIssuer(`http://id.${domain}:${process.env.SANDBOX_PUBLIC_PORT ?? '18000'}/`)
  .setAudience(aud)
  .setIssuedAt()
  .setExpirationTime(ttl)
  .sign(key));
