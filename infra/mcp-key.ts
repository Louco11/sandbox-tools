/**
 * Где живёт личный ключ MCP на машине человека: Keychain (macOS) или файл 0600 в ~/.sandbox.
 * В конфигах агента ключа нет — мост берёт его отсюда. Переменная окружения побеждает: так удобно в CI и в контейнере.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const KEY_ENV = 'SANDBOX_MCP_KEY';
const DIR = join(process.env.SANDBOX_HOME ?? homedir(), '.sandbox');
const file = (domain: string) => join(DIR, `key-${domain.replace(/[^a-z0-9.-]/gi, '_')}`);
const service = (domain: string) => `sandbox-mcp ${domain}`;
const mac = process.platform === 'darwin';

export async function saveKey(domain: string, key: string): Promise<string> {
  if (mac) {
    const r = spawnSync('security', ['add-generic-password', '-a', 'sandbox', '-s', service(domain), '-w', key, '-U'], { stdio: 'ignore' });
    if (r.status === 0) return 'сохранён в Keychain';
  }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(file(domain), key, { mode: 0o600 });
  chmodSync(file(domain), 0o600);
  return `сохранён в ${file(domain)}`;
}

export function loadKey(domain: string): string | null {
  const fromEnv = process.env[KEY_ENV];
  if (fromEnv) return fromEnv;
  if (mac) {
    const r = spawnSync('security', ['find-generic-password', '-a', 'sandbox', '-s', service(domain), '-w'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return existsSync(file(domain)) ? readFileSync(file(domain), 'utf8').trim() : null;
}
