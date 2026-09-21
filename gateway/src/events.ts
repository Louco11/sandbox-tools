/**
 * События из аудита с фильтрами (П3, П4). Сводка на главной отвечает «как дела», а сюда приходят с вопросом
 * «кто и что делал в этом туле за две недели и почему были отказы» — и ответ должен находиться без psql.
 *
 * Показываем только то, что человеку и так доступно: свои тулы, администратору песочницы — все.
 * Фильтры честно возвращаются обратно, чтобы срез можно было сохранить ссылкой.
 */
import { service } from './db.ts';
import { SERVICE_ACTORS } from './platform.ts';

export interface EventFilter {
  days: number;
  tool?: string;
  actor?: string;
  source?: string;
  /** web — человек в браузере, mcp — человек в хосте агента. */
  channel?: 'web' | 'mcp';
  kind?: 'read' | 'write' | 'access' | 'admin';
  /** Только отказы: с этого обычно и начинают разбор. */
  denied?: boolean;
  people?: boolean;
  /** Порядок журнала по времени и колонка сортировки сводки по людям: таблицы сортируются (П3). */
  order?: 'asc' | 'desc';
  sort?: 'calls' | 'denied' | 'writes' | 'via_agent' | 'tools' | 'last_at' | 'actor';
  limit: number;
  offset: number;
}

const APPLIED = ['write.apply', 'write.commit', 'write.commit_approved'];
const KINDS: Record<string, string> = {
  read: "operation LIKE 'query%'",
  write: "operation LIKE 'write.%'",
  access: "(operation LIKE 'access%' OR operation LIKE 'group.%' OR operation LIKE 'key.%')",
  admin: "(operation LIKE 'tool.%' OR operation LIKE 'token.%' OR operation LIKE 'auth %')",
};

export interface EventRow {
  id: number; at: Date; actor: string; tool: string; source: string | null;
  operation: string; agent_in_chain: boolean; allowed: boolean; reason: string | null; fields: string[] | null;
}

/**
 * Условия среза одним местом: журнал и сводка по людям должны показывать одно и то же, иначе на странице тула
 * в сводке окажутся чужие цифры.
 */
function conditions(f: EventFilter, visible: string[] | null) {
  const where: string[] = [`at > now() - make_interval(days => $1)`];
  const params: unknown[] = [Math.max(1, Math.min(365, Math.floor(f.days)))];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };
  let empty = false;
  if (visible) {
    if (!visible.length) empty = true;
    add('split_part(tool, \'--\', 1) = ANY($n)', visible);
  }
  // Период и круг видимости — общие: списки для фильтров считаем по ним, до сужения.
  const facetCount = params.length;
  if (f.tool) add('split_part(tool, \'--\', 1) = $n', f.tool);
  if (f.actor) add('actor = $n', f.actor);
  if (f.source) add('source = $n', f.source);
  if (f.channel === 'mcp') where.push('agent_in_chain');
  if (f.channel === 'web') where.push('NOT agent_in_chain');
  if (f.denied) where.push('NOT allowed');
  if (f.people) add('NOT (actor = ANY($n))', SERVICE_ACTORS);
  if (f.kind) where.push(KINDS[f.kind]!);
  return {
    empty, params, sql: where.join(' AND '),
    facetSql: where.slice(0, facetCount).join(' AND '), facetParams: params.slice(0, facetCount),
  };
}

/**
 * Поиск по журналу. visible = null — видно всё (администратор), иначе только эти тулы.
 * Возвращаем и строки, и сводку по срезу: сколько всего, сколько отказов, сколько людей.
 */
export async function events(f: EventFilter, visible: string[] | null) {
  const { empty, sql, params, facetSql, facetParams } = conditions(f, visible);
  if (empty) return { rows: [], total: 0, denied: 0, people: 0, tools: [], actors: [], sources: [] };

  const [rows, totals, facets] = await Promise.all([
    service.query<EventRow>(
      `SELECT id, at, actor, tool, source, operation, agent_in_chain, allowed, reason, fields
         FROM audit.calls WHERE ${sql} ORDER BY id ${f.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${Math.min(500, Math.max(1, f.limit))} OFFSET ${Math.max(0, f.offset)}`,
      params,
    ),
    service.query<{ total: number; denied: number; people: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT allowed)::int AS denied,
              count(DISTINCT actor) FILTER (WHERE NOT (actor = ANY($${params.length + 1})))::int AS people
         FROM audit.calls WHERE ${sql}`,
      [...params, SERVICE_ACTORS],
    ),
    // Чем фильтровать — из периода и круга видимости, а не из уже суженного среза: иначе, выбрав один тул,
    // нельзя переключиться на другой, не сбросив всё.
    service.query<{ tools: string[]; actors: string[]; sources: string[] }>(
      `SELECT array_agg(DISTINCT split_part(tool, '--', 1)) AS tools,
              array_agg(DISTINCT actor) AS actors,
              array_remove(array_agg(DISTINCT source), NULL) AS sources
         FROM audit.calls WHERE ${facetSql}`,
      facetParams,
    ),
  ]);

  return {
    rows: rows.rows,
    ...totals.rows[0]!,
    tools: facets.rows[0]?.tools ?? [],
    actors: (facets.rows[0]?.actors ?? []).filter((a) => !SERVICE_ACTORS.includes(a)),
    sources: facets.rows[0]?.sources ?? [],
  };
}

/** Колонки, по которым сводку можно отсортировать: список закрытый — значение идёт в SQL. */
const SORTS: Record<string, string> = {
  actor: 'actor ASC', calls: 'calls DESC', denied: 'denied DESC', writes: 'writes DESC',
  via_agent: 'via_agent DESC', tools: 'tools DESC', last_at: 'last_at DESC',
};

/** Сводка по срезу: кто, сколько и когда в последний раз — для страницы «по людям». */
export async function eventsByActor(f: EventFilter, visible: string[] | null) {
  const { empty, sql, params } = conditions(f, visible);
  if (empty) return [];
  const { rows } = await service.query<{ actor: string; calls: number; denied: number; writes: number; via_agent: number; tools: number; last_at: Date }>(
    `SELECT actor, count(*)::int AS calls, count(*) FILTER (WHERE NOT allowed)::int AS denied,
            count(*) FILTER (WHERE operation = ANY($${params.length + 1}))::int AS writes,
            count(*) FILTER (WHERE agent_in_chain)::int AS via_agent,
            count(DISTINCT split_part(tool, '--', 1))::int AS tools, max(at) AS last_at
       FROM audit.calls
      WHERE ${sql} AND NOT (actor = ANY($${params.length + 2}))
      GROUP BY actor ORDER BY ${SORTS[f.sort ?? 'calls'] ?? SORTS.calls} LIMIT 100`,
    [...params, APPLIED, SERVICE_ACTORS],
  );
  return rows;
}
