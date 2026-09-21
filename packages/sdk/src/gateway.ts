/**
 * Клиент гейтвея — единственный способ тула получить данные.
 * Адрес гейтвея и секрет приходят из окружения при деплое; тул их не видит и не задаёт.
 */

export type Scalar = string | number | boolean | null;

export interface QueryInput {
  fields?: string[];
  where?: { field: string; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains'; value: Scalar | Scalar[] }[];
  order_by?: { field: string; dir?: 'asc' | 'desc' };
  limit?: number;
}

export interface QueryResult<Row> {
  source: string;
  dataset: string;
  fields: Record<string, string>;
  row_count: number;
  rows: Row[];
}

export interface PreparedWrite {
  confirmation_id: string;
  summary: string;
  expires_at: string;
  requires?: string;
}

/** Результат немедленной записи из UI (без агента). */
export interface AppliedWrite {
  done: true;
  summary: string;
  committed_by: string;
  [key: string]: unknown;
}

export type WriteResult = PreparedWrite | AppliedWrite;

/** Срок жизни тула: когда истекает, до какого момента продлевается использованием, был ли простой. */
export interface Lifecycle {
  tool: string;
  owner: string;
  /** Кто решает за владельца по справочнику: ушёл — руководитель, группа — её участники. */
  owners: string[];
  owner_note: string | null;
  expires_at: string;
  auto_extend_until: string | null;
  auto_extend_days: number;
  last_human_at: string | null;
  idle_notified_at: string | null;
  idle_revived_at: string | null;
  idle_days: number;
  max_ttl_days: number;
}

/** От чьего имени идёт вызов: живой человек и, если есть, агент в цепочке. */
export interface Caller {
  actor: string;
  agent: string | null;
  /**
   * Подписанная личность человека (X-Sandbox-Identity), как её выдал сервис identity. Тул её не придумывает
   * и не меняет — только пересылает в гейтвей, который проверяет подпись и aud.
   */
  identity: string | null;
}

export class GatewayError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class GatewayClient {
  #url: string;
  #tool: string;
  #secret: string;
  #token: { value: string; exp: number } | null = null;

  constructor(url: string, tool: string, secret: string) {
    this.#url = url.replace(/\/$/, '');
    this.#tool = tool;
    this.#secret = secret;
  }

  static fromEnv(): GatewayClient {
    const { GATEWAY_URL, TOOL_INSTANCE, TOOL_CLIENT_SECRET } = process.env;
    if (!GATEWAY_URL || !TOOL_INSTANCE || !TOOL_CLIENT_SECRET) {
      throw new Error('нет GATEWAY_URL / TOOL_INSTANCE / TOOL_CLIENT_SECRET — тул запускается только деплоем из charts/tool-base');
    }
    return new GatewayClient(GATEWAY_URL, TOOL_INSTANCE, TOOL_CLIENT_SECRET);
  }

  get tool(): string {
    return this.#tool;
  }

  async #accessToken(force = false): Promise<string> {
    if (!force && this.#token && this.#token.exp - 30_000 > Date.now()) return this.#token.value;
    const res = await fetch(`${this.#url}/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: this.#tool, client_secret: this.#secret }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; message?: string };
    if (!res.ok || !body.access_token) {
      throw new GatewayError(res.status, body.error ?? 'token_failed', body.message ?? 'гейтвей не выдал токен');
    }
    this.#token = { value: body.access_token, exp: Date.now() + (body.expires_in ?? 60) * 1000 };
    return this.#token.value;
  }

  async #call<T>(path: string, body: unknown, caller: Caller, retried = false): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await this.#accessToken(retried)}`,
    };
    if (!caller.identity) throw new GatewayError(401, 'unauthorized', 'у вызова нет подписанной личности человека');
    headers['X-Sandbox-Identity'] = caller.identity;
    if (caller.agent) headers['X-Agent'] = caller.agent;

    const res = await fetch(`${this.#url}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
    if (res.status === 401 && !retried) return this.#call(path, body, caller, true);
    if (!res.ok) throw new GatewayError(res.status, data.error ?? 'gateway_error', data.message ?? `гейтвей ответил ${res.status}`);
    return data;
  }

  query<Row = Record<string, unknown>>(caller: Caller, source: string, dataset: string, q: QueryInput = {}) {
    return this.#call<QueryResult<Row>>(`/v1/sources/${encodeURIComponent(source)}/query`, { dataset, ...q }, caller);
  }

  /**
   * Запись: из UI (без агента) — сразу apply (важное действие гейтвей вернёт на подтверждение);
   * с агентом — только prepare: человек соглашается в чате, агент применяет commit_approved.
   */
  prepareWrite(caller: Caller, write: string, params: Record<string, string | number>) {
    const path = caller.agent
      ? `/v1/writes/${encodeURIComponent(write)}/prepare`
      : `/v1/writes/${encodeURIComponent(write)}/apply`;
    return this.#call<WriteResult>(path, { params }, caller);
  }

  lifecycle(caller: Caller) {
    return this.#call<Lifecycle>('/v1/lifecycle', {}, caller);
  }

  extendLifecycle(caller: Caller, days?: number) {
    return this.#call<Lifecycle>('/v1/lifecycle/extend', days === undefined ? {} : { days }, caller);
  }

  revokeLifecycle(caller: Caller) {
    return this.#call<{ tool: string; revoked: true }>('/v1/lifecycle/revoke', {}, caller);
  }

  commitWrite(caller: Caller, confirmationId: string, approval?: string) {
    return this.#call<{ done: true; summary: string; committed_by: string } & Record<string, unknown>>(
      `/v1/writes/confirmations/${encodeURIComponent(confirmationId)}/commit`,
      approval === undefined ? {} : { approval },
      caller,
    );
  }
}
