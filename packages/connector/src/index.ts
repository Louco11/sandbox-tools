/**
 * Каркас коннектора источника: сервис команды данных за гейтвеем.
 *
 * Гейтвей уже проверил скоуп тула, набор, поля, параметры записи и написал аудит. Коннектору остаётся:
 *   POST /query                    { dataset, fields, where, order_by, limit } → { rows }
 *   POST /writes/<id>/describe     { params }                                  → { summary }   — что изменится, для человека
 *   POST /writes/<id>/apply        { params, decided_by, agent }               → { result }
 *   GET  /healthz
 *   GET  /_meta                    → { name, datasets, writes } — состав коннектора, для проверки контракта (с токеном)
 * Помощники: applyQuery — фильтр в памяти (API, файлы, MCP); sqlSelect — запрос → SQL с параметрами (БД).
 * Запросы принимаются только с токеном гейтвея (Authorization: Bearer). Ошибка для человека — ConnectorError(4xx).
 * Без npm-зависимостей: node:http.
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export type Row = Record<string, unknown>;
export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';

export interface Query {
  dataset: string;
  fields: string[];
  where: { field: string; op: Op; value: unknown }[];
  order_by?: { field: string; dir: 'asc' | 'desc' };
  limit: number;
}

export type Params = Record<string, string | number>;

export interface WriteHandler {
  /** Проверить, что запись применима сейчас, и сказать человеку, что изменится. Данные не менять. */
  describe(params: Params): Promise<string> | string;
  /** Выполнить. decided_by — человек, решивший записать; agent — агент, который готовил, если был. */
  apply(params: Params, by: { decided_by: string; agent: string | null }): Promise<Row | void> | Row | void;
}

export interface ConnectorDef {
  name: string;
  /** Токен, по которому коннектор узнаёт гейтвей (тот же, что в token_env у гейтвея). */
  token: string;
  /** Набор данных → чтение. Проще всего вернуть все строки и отдать фильтрацию applyQuery. */
  datasets: Record<string, (q: Query) => Promise<Row[]> | Row[]>;
  writes: Record<string, WriteHandler>;
  port?: number;
}

/** Ошибка, которую гейтвей покажет человеку как есть (400 — неверные данные, 404 — нет объекта, 409 — конфликт). */
export class ConnectorError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

const cmp = (a: unknown, b: unknown) => (a === b ? 0 : (a as number) < (b as number) ? -1 : 1);

/** Фильтр, сортировка, лимит и поля по уже проверенному гейтвеем запросу — для коннекторов, которые читают всё в память. */
export function applyQuery(rows: Row[], q: Query): Row[] {
  const test = (r: Row) =>
    q.where.every(({ field, op, value }) => {
      const v = r[field];
      switch (op) {
        case 'eq': return v === value;
        case 'ne': return v !== value;
        case 'gt': return cmp(v, value) > 0;
        case 'gte': return cmp(v, value) >= 0;
        case 'lt': return cmp(v, value) < 0;
        case 'lte': return cmp(v, value) <= 0;
        case 'in': return Array.isArray(value) && value.includes(v);
        case 'contains': return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
      }
    });
  const out = rows.filter(test);
  if (q.order_by) {
    const { field, dir } = q.order_by;
    out.sort((a, b) => cmp(a[field], b[field]) * (dir === 'desc' ? -1 : 1));
  }
  return out.slice(0, q.limit).map((r) => Object.fromEntries(q.fields.map((f) => [f, r[f] ?? null])));
}

const SQL_OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/**
 * Запрос гейтвея → SELECT для Postgres с параметрами ($1, $2…). Таблица и колонки — из описания коннектора,
 * а не из запроса: поле, которого коннектор не знает, — отказ, даже если гейтвей его пропустил. Значения — только
 * параметрами, идентификаторы — только из списка колонок. Для других СУБД — тот же подход со своими плейсхолдерами.
 */
export function sqlSelect(table: string, columns: readonly string[], q: Query): { text: string; values: unknown[] } {
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`таблица ${table}: ожидается schema.table`);
  const col = (c: string) => {
    if (!columns.includes(c)) throw new ConnectorError(400, `в наборе ${q.dataset} нет поля ${c}`);
    return `"${c}"`;
  };
  const values: unknown[] = [];
  const conds = q.where.map(({ field, op, value }) => {
    if (op === 'in') {
      values.push(value);
      return `${col(field)} = ANY($${values.length})`;
    }
    if (op === 'contains') {
      values.push(`%${String(value)}%`);
      return `${col(field)}::text ILIKE $${values.length}`;
    }
    values.push(value);
    return `${col(field)} ${SQL_OPS[op]} $${values.length}`;
  });
  const [schema, name] = table.split('.') as [string, string];
  const text = [
    `SELECT ${q.fields.map(col).join(', ')} FROM "${schema}"."${name}"`,
    conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    q.order_by ? `ORDER BY ${col(q.order_by.field)} ${q.order_by.dir === 'desc' ? 'DESC' : 'ASC'}` : '',
    `LIMIT ${Math.max(0, Math.floor(q.limit))}`,
  ].filter(Boolean).join(' ');
  return { text, values };
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function startConnector(def: ConnectorDef): http.Server {
  if (!def.token) throw new Error(`коннектор ${def.name}: нет токена гейтвея`);
  const log = (e: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), connector: def.name, ...e }));

  const server = http.createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
    if (req.method === 'GET' && req.url === '/healthz') return reply(200, { ok: true });
    if (!same(req.headers.authorization ?? '', `Bearer ${def.token}`)) return reply(401, { error: 'unauthorized', message: 'только гейтвей' });
    if (req.method === 'GET' && req.url === '/_meta') {
      return reply(200, { name: def.name, datasets: Object.keys(def.datasets), writes: Object.keys(def.writes) });
    }
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });

    let body: Record<string, unknown>;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return reply(400, { error: 'bad_request', message: 'ожидается JSON' });
    }

    try {
      const url = req.url ?? '';
      if (url === '/query') {
        const q = body as unknown as Query;
        const read = def.datasets[q.dataset];
        if (!read) return reply(404, { error: 'not_found', message: `у источника ${def.name} нет набора ${q.dataset}` });
        return reply(200, { rows: await read(q) });
      }
      const m = url.match(/^\/writes\/([^/]+)\/(describe|apply)$/);
      const handler = m ? def.writes[decodeURIComponent(m[1]!)] : undefined;
      if (!m || !handler) return reply(404, { error: 'not_found', message: `у источника ${def.name} нет записи ${m?.[1] ?? url}` });
      const params = (body.params ?? {}) as Params;
      if (m[2] === 'describe') return reply(200, { summary: await handler.describe(params) });
      const by = { decided_by: String(body.decided_by ?? ''), agent: (body.agent as string | null) ?? null };
      const result = await handler.apply(params, by);
      log({ type: 'write', write: m[1], decided_by: by.decided_by, agent: by.agent });
      return reply(200, { result: result ?? {} });
    } catch (e) {
      if (e instanceof ConnectorError) return reply(e.status, { error: 'rejected', message: e.message });
      log({ type: 'error', error: (e as Error).message });
      return reply(500, { error: 'internal' });
    }
  });
  server.listen(def.port ?? Number(process.env.PORT ?? 8080), () => log({ type: 'started', datasets: Object.keys(def.datasets), writes: Object.keys(def.writes) }));
  return server;
}
