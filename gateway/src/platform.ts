import { registry, registryState } from './config.ts';
import { service } from './db.ts';
import { directorySummary } from './directory.ts';

/** Служебные учётки платформы в аудите — не люди: в «кто пользовался» не попадают. */
export const SERVICE_ACTORS = ['admin', 'deployer', 'reaper', 'portal', 'system', 'ci', 'owner', '(unknown)'];

/**
 * Активность тула за последние дни — из аудита, для страницы тула на главной: кто пользовался (сам или через агента),
 * какие записи применены (кто решил, с агентом ли, согласие из чата), последние отказы.
 */
export async function toolActivity(tool: string, days: number) {
  const since = `now() - make_interval(days => ${Math.max(1, Math.min(365, Math.floor(days)))})`;
  const [people, writes, denials, totals] = await Promise.all([
    service.query<{ actor: string; calls: number; via_agent: number; last_at: Date }>(
      `SELECT actor, count(*)::int AS calls, count(*) FILTER (WHERE agent_in_chain)::int AS via_agent, max(at) AS last_at
         FROM audit.calls WHERE tool = $1 AND at > ${since} AND allowed AND NOT (actor = ANY($2))
        GROUP BY actor ORDER BY last_at DESC LIMIT 50`,
      [tool, SERVICE_ACTORS],
    ),
    service.query<{ at: Date; actor: string; operation: string; write: string; agent_in_chain: boolean; reason: string | null }>(
      `SELECT at, actor, operation, source AS write, agent_in_chain, reason
         FROM audit.calls WHERE tool = $1 AND at > ${since} AND allowed AND operation IN ('write.apply', 'write.commit', 'write.commit_approved')
        ORDER BY at DESC LIMIT 30`,
      [tool],
    ),
    service.query<{ at: Date; actor: string; operation: string; reason: string | null }>(
      `SELECT at, actor, operation, reason FROM audit.calls WHERE tool = $1 AND at > ${since} AND NOT allowed ORDER BY at DESC LIMIT 10`,
      [tool],
    ),
    service.query<{ calls: number; denied: number }>(
      `SELECT count(*) FILTER (WHERE allowed)::int AS calls, count(*) FILTER (WHERE NOT allowed)::int AS denied
         FROM audit.calls WHERE tool = $1 AND at > ${since}`,
      [tool],
    ),
  ]);
  return { tool, days, ...totals.rows[0], people: people.rows, writes: writes.rows, denials: denials.rows };
}

/** Уборка истории: строки тулов, отозванных или истёкших больше недели назад. Аудит не трогаем. */
export async function pruneTools(): Promise<string[]> {
  const dead = `COALESCE(revoked_at, expires_at) < now() - interval '7 days'`;
  const client = await service.connect();
  try {
    await client.query('BEGIN');
    // Сначала — в историю жизней (метрики выживаемости), потом удаляем: одной транзакцией, чтобы жизнь не потерялась.
    await client.query(
      `INSERT INTO gateway.tool_history (name, owner, manifest, born_at, ended_at, end_reason, last_human_at)
       SELECT name, owner, manifest, registered_at, COALESCE(revoked_at, expires_at),
              CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN idle_notified_at IS NOT NULL THEN 'idle' ELSE 'expired' END,
              last_human_at
         FROM gateway.tools WHERE ${dead}`,
    );
    await client.query(`DELETE FROM gateway.pending_writes WHERE tool IN (SELECT name FROM gateway.tools WHERE ${dead})`);
    const { rows } = await client.query<{ name: string }>(`DELETE FROM gateway.tools WHERE ${dead} RETURNING name`);
    await client.query('COMMIT');
    return rows.map((r) => r.name);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Когда уборщик последний раз прошёл цикл (он вызывает sweep-idle на каждом). В памяти гейтвея — до перезапуска. */
export const reaperState = { last_sweep_at: null as Date | null };

/** Здоровье платформы для главной: реестр, каждый коннектор (гейтвей опрашивает сам — он в сети sources), уборщик. */
export async function platformState() {
  const connectors = await Promise.all(Object.entries(registry.sources).map(async ([source, s]) => {
    const started = Date.now();
    const ok = await fetch(new URL('healthz', s.connector.url.endsWith('/') ? s.connector.url : `${s.connector.url}/`), { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok, () => false);
    return { source, title: s.title, ok, ms: Date.now() - started, token: Boolean(process.env[s.connector.token_env]) };
  }));
  // Считаем только тулы конвейера: демо-регистрации админа — не тулы, иначе цифры расходятся с метриками.
  const { rows } = await service.query<{ active: number; previews: number; expiring: number; idle: number }>(
    `WITH pipeline AS (
       SELECT DISTINCT split_part(tool, '--', 1) AS name FROM audit.calls
        WHERE operation = 'tool.register' AND allowed AND actor = 'deployer'
     )
     SELECT count(*) FILTER (WHERE name NOT LIKE '%--%')::int AS active,
            count(*) FILTER (WHERE name LIKE '%--%')::int AS previews,
            count(*) FILTER (WHERE name NOT LIKE '%--%' AND expires_at < now() + interval '7 days')::int AS expiring,
            count(*) FILTER (WHERE idle_notified_at IS NOT NULL)::int AS idle
       FROM gateway.tools
      WHERE revoked_at IS NULL AND expires_at > now() AND split_part(name, '--', 1) IN (SELECT name FROM pipeline)`,
  );
  return {
    registry: { loaded_at: registryState.loaded_at, reload_error: registryState.error, sources: Object.keys(registry.sources).length, writes: Object.keys(registry.writes).length },
    connectors,
    reaper: reaperState,
    directory: directorySummary(),
    tools: rows[0],
  };
}
