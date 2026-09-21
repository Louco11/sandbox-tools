/** Настройки главной: адреса гейтвея и Gitea, токен роли portal, домен витрины. */
export const PORT = Number(process.env.PORT ?? 3000);
export const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://gateway:8080';
export const PORTAL_TOKEN = process.env.GATEWAY_PORTAL_TOKEN ?? '';
export const GITEA_URL = process.env.GITEA_URL ?? 'http://gitea:3000';
export const GITEA_PUBLIC = process.env.GITEA_PUBLIC_URL ?? 'http://localhost:13000';
export const REPO = 'platform/internal-tools';
export const GITEA_AUTH = Buffer.from(`${process.env.GITEA_AGENT_USER ?? ''}:${process.env.GITEA_AGENT_PASSWORD ?? ''}`).toString('base64');
export const WORKTREE = process.env.REPO_DIR ?? '/repo';
export const DOMAIN = process.env.SANDBOX_DOMAIN ?? 'tools.localhost';
export const TOOL_URL = (instance: string) => `http://${instance}.${DOMAIN}:18000`;
export const DAY = 86_400_000;
export const PUBLIC_PORT = process.env.SANDBOX_PUBLIC_PORT ?? '18000';
/** Личность человека от ForwardAuth: ставит только Traefik через сервис identity (шаг Б1). */
export const IDENTITY_HEADER = 'x-sandbox-identity';
export const IDENTITY_URL = process.env.IDENTITY_URL ?? 'http://identity:8080';
export const NOTIFIER_URL = process.env.NOTIFIER_URL ?? 'http://notifier:8080';
export const NOTIFY_TOKEN = process.env.NOTIFY_PORTAL_TOKEN ?? '';
