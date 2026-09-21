/**
 * Настройка IdP стенда (Keycloak) из кода: реалм, публичный клиент с PKCE, группы и люди справочника.
 * В компании этот шаг делает ИБ в своём IdP — здесь он автоматизирован, чтобы стенд поднимался одной командой.
 * Пароли: человеку стенда заводится временный (сменить при первом входе), демо-людям — общий пароль стенда.
 */
const ADMIN_USER = process.env.KEYCLOAK_ADMIN_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? '';

export interface KeycloakConfig {
  url: string;
  realm: string;
  clientId: string;
  redirectUris: string[];
  human: string;
  humanTempPassword: string;
  demoPassword: string;
  /** Логин → группы. Берётся из справочника сотрудников. */
  people: Record<string, string[]>;
}

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

async function adminToken(url: string): Promise<string> {
  const res = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Keycloak: вход администратора ${res.status}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Ждём, пока IdP поднимется: compose стартует его параллельно. */
export async function waitForKeycloak(url: string, seconds = 180): Promise<void> {
  for (let i = 0; i < seconds; i++) {
    const ok = await fetch(`${url}/realms/master/.well-known/openid-configuration`, { signal: AbortSignal.timeout(3000) })
      .then((r) => r.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Keycloak не поднялся за ${seconds} с`);
}

/** Группы человека в IdP на момент вызова: ключ MCP не хранит прав, они перечитываются. */
export async function groupsOf(url: string, realm: string, login: string): Promise<string[]> {
  const token = await adminToken(url);
  const head = { Authorization: `Bearer ${token}` };
  const users = (await (await fetch(`${url}/admin/realms/${realm}/users?username=${encodeURIComponent(login)}&exact=true`, { headers: head })).json()) as { id: string }[];
  if (!users.length) return [];
  const groups = (await (await fetch(`${url}/admin/realms/${realm}/users/${users[0]!.id}/groups`, { headers: head })).json()) as { name: string }[];
  return groups.map((g) => g.name);
}

export async function bootstrap(cfg: KeycloakConfig): Promise<void> {
  const token = await adminToken(cfg.url);
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${cfg.url}/admin/realms${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok && res.status !== 409) throw new Error(`Keycloak ${method} ${path}: ${res.status} ${await res.text()}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : null;
  };

  const realms = (await api('GET', '')) as { realm: string }[];
  if (!realms.some((r) => r.realm === cfg.realm)) {
    await api('POST', '', { realm: cfg.realm, enabled: true, displayName: 'Песочница внутренних тулов', loginTheme: 'keycloak' });
    log({ type: 'realm_created', realm: cfg.realm });
  }

  // Публичный клиент с обязательным PKCE: секрета в репозитории нет и не нужно.
  const clients = (await api('GET', `/${cfg.realm}/clients?clientId=${cfg.clientId}`)) as { id: string }[];
  const client = {
    clientId: cfg.clientId,
    name: 'Песочница',
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    redirectUris: cfg.redirectUris,
    webOrigins: ['+'],
    // Device flow — вход агента: человек подтверждает его в браузере, ключей у агента нет (шаг Б1.2).
    attributes: { 'pkce.code.challenge.method': 'S256', 'oauth2.device.authorization.grant.enabled': 'true' },
  };
  if (clients.length) await api('PUT', `/${cfg.realm}/clients/${clients[0]!.id}`, { ...client, id: clients[0]!.id });
  else await api('POST', `/${cfg.realm}/clients`, client);

  // Группы в токен: без этого гейтвей не узнает, кто администратор песочницы.
  const cid = ((await api('GET', `/${cfg.realm}/clients?clientId=${cfg.clientId}`)) as { id: string }[])[0]!.id;
  const mappers = (await api('GET', `/${cfg.realm}/clients/${cid}/protocol-mappers/models`)) as { name: string }[];
  if (!mappers.some((m) => m.name === 'groups')) {
    await api('POST', `/${cfg.realm}/clients/${cid}/protocol-mappers/models`, {
      name: 'groups', protocol: 'openid-connect', protocolMapper: 'oidc-group-membership-mapper',
      config: { 'claim.name': 'groups', 'full.path': 'false', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true' },
    });
  }

  const groups = new Set(Object.values(cfg.people).flat());
  const existing = (await api('GET', `/${cfg.realm}/groups`)) as { name: string; id: string }[];
  for (const g of groups) if (!existing.some((e) => e.name === g)) await api('POST', `/${cfg.realm}/groups`, { name: g });
  const allGroups = (await api('GET', `/${cfg.realm}/groups`)) as { name: string; id: string }[];

  for (const [login, memberOf] of Object.entries(cfg.people)) {
    const found = (await api('GET', `/${cfg.realm}/users?username=${encodeURIComponent(login)}&exact=true`)) as { id: string }[];
    const isHuman = login === cfg.human;
    if (!found.length) {
      await api('POST', `/${cfg.realm}/users`, {
        username: login, enabled: true, emailVerified: true,
        credentials: [{ type: 'password', value: isHuman ? cfg.humanTempPassword : cfg.demoPassword, temporary: isHuman }],
      });
      log({ type: 'user_created', login, temporary_password: isHuman });
    }
    const user = ((await api('GET', `/${cfg.realm}/users?username=${encodeURIComponent(login)}&exact=true`)) as { id: string }[])[0]!;
    for (const g of memberOf) {
      const group = allGroups.find((x) => x.name === g);
      if (group) await api('PUT', `/${cfg.realm}/users/${user.id}/groups/${group.id}`);
    }
  }
  log({ type: 'bootstrap_done', realm: cfg.realm, client: cfg.clientId, people: Object.keys(cfg.people).length, groups: [...groups] });
}
