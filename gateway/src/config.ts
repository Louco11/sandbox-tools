import { loadRegistry, type Registry } from '@sandbox/manifest';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`не задана переменная окружения ${name}`);
  return v;
}

/** Что можно сервисной учётке платформы на /v1/admin. Каждая роль — отдельный токен. */
export type AdminScope =
  | 'tools.register' | 'tools.list' | 'tools.sweep' | 'tools.extend' | 'tools.revoke' | 'tools.revoke-preview'
  | 'tools.activity' | 'platform.read' | 'directory.read' | 'groups.read' | 'groups.write';

const ROLES: { role: string; env: string; scopes: AdminScope[] }[] = [
  // Человек-администратор стенда: make tools / extend / revoke, демо.
  { role: 'admin', env: 'GATEWAY_ADMIN_TOKEN', scopes: ['tools.register', 'tools.list', 'tools.sweep', 'tools.extend', 'tools.revoke', 'tools.activity', 'platform.read', 'groups.read', 'groups.write'] },
  // Деплоер и make deploy: допуск тула по манифесту и отзыв превью удалённых веток. Прод отозвать не может.
  { role: 'deployer', env: 'GATEWAY_DEPLOY_TOKEN', scopes: ['tools.register', 'tools.revoke-preview'] },
  // Уборщик: видит сроки, отмечает простой, убирает строки давно отозванных тулов. Продлевать и отзывать не может.
  { role: 'reaper', env: 'GATEWAY_REAPER_TOKEN', scopes: ['tools.list', 'tools.sweep'] },
  // Главная страница: каталог, активность тула из аудита, здоровье платформы; «Продлить» и «Удалить» от имени
  // человека (X-Actor) — гейтвей пускает, только если он решает за владельца по справочнику. Личность до шага Б1 —
  // заглушка SSO главной.
  { role: 'portal', env: 'GATEWAY_PORTAL_TOKEN', scopes: ['tools.list', 'tools.revoke', 'tools.extend', 'tools.activity', 'platform.read', 'groups.read', 'groups.write'] },
  // Сервис уведомлений: только узнать по справочнику, кому доставить (логин, группа, адрес автора коммита).
  { role: 'notifier', env: 'GATEWAY_NOTIFIER_TOKEN', scopes: ['directory.read'] },
  // Сервис личности: узнать, в каких группах песочницы человек, чтобы положить их в личность.
  { role: 'identity', env: 'GATEWAY_IDENTITY_TOKEN', scopes: ['groups.read'] },
];

export const config = {
  port: Number(process.env.PORT ?? 8080),
  jwtSecret: new TextEncoder().encode(need('GATEWAY_JWT_SECRET')),
  adminRoles: ROLES.map((r) => ({ role: r.role, token: need(r.env), scopes: r.scopes })),
  pg: {
    host: process.env.PG_HOST ?? 'postgres',
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DATABASE ?? 'sources',
    servicePassword: need('PG_GATEWAY_PASSWORD'),
  },
};

export const REGISTRY_PATH = process.env.REGISTRY_PATH ?? '/registry/sources.yaml';
/** Демо-слой платформы: подмешивается, только когда SANDBOX_DEMO=1 (`make demo-on`). */
export const REGISTRY_DEMO_PATH = process.env.SANDBOX_DEMO === '1'
  ? process.env.REGISTRY_DEMO_PATH ?? '/registry/demo/sources.yaml'
  : undefined;

/**
 * Реестр — живая привязка: импортёры видят новое значение после reloadRegistry без перезапуска гейтвея.
 * Новый реестр применяется, только если он валиден целиком (см. main.ts); иначе работает прежний.
 */
export let registry: Registry = loadRegistry(REGISTRY_PATH, REGISTRY_DEMO_PATH);
export const registryState = { loaded_at: new Date(), error: null as string | null };

export function setRegistry(next: Registry): void {
  registry = next;
  registryState.loaded_at = new Date();
  registryState.error = null;
}
