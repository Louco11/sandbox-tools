/**
 * Вход в песочницу для агентов: bin/sandbox-mcp login [домен].
 *
 * Открывает страницу входа IdP, ждёт подтверждения человеком и кладёт личный ключ MCP в системное хранилище
 * (Keychain на macOS, иначе файл 0600 в ~/.sandbox). Мост берёт ключ оттуда — в конфигах агента ключа нет,
 * копировать руками ничего не нужно. Ротация: повторите эту же команду.
 */
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { saveKey, KEY_ENV } from './mcp-key.ts';

const domain = process.argv[2] || 'tools.localhost:18000';
const identity = `http://id.${domain}`;
const name = process.argv[3] || `${hostname()} (${process.platform})`;

const start = await fetch(`${identity}/device/start`, { method: 'POST' }).catch(() => null);
if (!start?.ok) {
  console.error(`sandbox-mcp login: сервис личности недоступен (${identity}). Песочница запущена?`);
  process.exit(1);
}
const d = (await start.json()) as { device_code: string; user_code: string; verification_url: string; interval: number; expires_in: number };
console.log(`Откройте ${d.verification_url}\nи подтвердите код ${d.user_code}`);
spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [d.verification_url], { stdio: 'ignore', detached: true }).unref();

const until = Date.now() + d.expires_in * 1000;
while (Date.now() < until) {
  await new Promise((r) => setTimeout(r, d.interval * 1000));
  const res = await fetch(`${identity}/device/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_code: d.device_code, want_key: true, name }),
  });
  if (res.status === 202) continue;
  if (!res.ok) {
    console.error(`sandbox-mcp login: вход не подтверждён (${(await res.json() as { status?: string }).status ?? res.status})`);
    process.exit(1);
  }
  const ok = (await res.json()) as { key: string; prefix: string; actor: string; expires_at: string };
  const where = await saveKey(domain, ok.key);
  console.log(`Готово: ${ok.actor}, ключ ${ok.prefix} до ${new Date(ok.expires_at).toLocaleDateString('ru-RU')} — ${where}.`);
  console.log(`Агенты подключаются без ключа в конфиге. Отозвать ключ: http://${domain}/me`);
  console.log(`Если ключ нужен в конфиге другого хоста, возьмите его в кабинете или задайте ${KEY_ENV}.`);
  process.exit(0);
}
console.error('sandbox-mcp login: вход не подтверждён вовремя');
process.exit(1);
