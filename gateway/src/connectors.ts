import type { SourceDef } from '@sandbox/manifest';
import { HttpError } from './errors.ts';

/**
 * Клиент коннектора — сервиса источника за гейтвеем. Коннектор видит только гейтвей (сеть sources) и узнаёт его по
 * токену из реестра (connector.token_env). Гейтвей уже проверил скоуп, набор, поля и параметры; коннектору остаётся
 * прочитать или записать. Ошибки 4xx коннектора передаются человеку как есть, прочее — «источник недоступен».
 */
const TIMEOUT_MS = 10_000;

export interface ConnectorQuery {
  dataset: string;
  fields: string[];
  where: { field: string; op: string; value: unknown }[];
  order_by?: { field: string; dir: 'asc' | 'desc' };
  limit: number;
}

async function call<T>(source: SourceDef, sourceId: string, path: string, body: unknown): Promise<T> {
  const c = source.connector!;
  const token = process.env[c.token_env];
  if (!token) throw new HttpError(503, 'connector_unconfigured', `у гейтвея нет токена коннектора ${sourceId} (${c.token_env})`);
  let res: Response;
  try {
    res = await fetch(new URL(path, c.url.endsWith('/') ? c.url : `${c.url}/`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new HttpError(502, 'connector_unavailable', `источник ${sourceId} недоступен: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (res.ok) return data;
  if (res.status >= 400 && res.status < 500 && res.status !== 401) {
    throw new HttpError(res.status, data.error ?? 'connector_rejected', data.message ?? `источник ${sourceId} отказал`);
  }
  throw new HttpError(502, 'connector_failed', `источник ${sourceId} ответил ${res.status}`);
}

export async function connectorQuery(source: SourceDef, sourceId: string, q: ConnectorQuery): Promise<Record<string, unknown>[]> {
  const { rows } = await call<{ rows: Record<string, unknown>[] }>(source, sourceId, 'query', q);
  if (!Array.isArray(rows)) throw new HttpError(502, 'connector_failed', `источник ${sourceId} вернул не rows`);
  // Коннектору не доверяем больше, чем нужно: только запрошенные поля и не больше лимита.
  return rows.slice(0, q.limit).map((r) => Object.fromEntries(q.fields.map((f) => [f, r[f] ?? null])));
}

export async function connectorDescribe(source: SourceDef, sourceId: string, writeId: string, params: Record<string, unknown>): Promise<string> {
  const { summary } = await call<{ summary: string }>(source, sourceId, `writes/${encodeURIComponent(writeId)}/describe`, { params });
  if (typeof summary !== 'string' || !summary) throw new HttpError(502, 'connector_failed', `источник ${sourceId} не описал запись`);
  return summary;
}

export async function connectorApply(
  source: SourceDef,
  sourceId: string,
  writeId: string,
  params: Record<string, unknown>,
  by: { decidedBy: string; agent: string | null },
): Promise<Record<string, unknown>> {
  const { result } = await call<{ result?: Record<string, unknown> }>(
    source, sourceId, `writes/${encodeURIComponent(writeId)}/apply`, { params, decided_by: by.decidedBy, agent: by.agent },
  );
  return result ?? {};
}
