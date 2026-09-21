/**
 * Метрики песочницы (шаг А5) — сколько стоит тул и сколько их выживает. Только агрегаты из аудита и жизненного
 * цикла, без данных источников. Считаются тулы, которые хоть раз выкатил деплоер (прошли конвейер ветка → CI → превью
 * или прод), — демо-регистрации администратора не в счёт. Превью — это проверка, а не использование: в использование
 * не входят.
 *
 * Что считать «использованием» (открытие, завершённое действие, человеко-часы) — решение людей (roadmap, раздел 4),
 * поэтому отдаём несколько мер рядом: люди, человеко-дни, вызовы, завершённые записи.
 *
 * Человек видит метрики только по своим тулам — тем, что ему открыты. Администратор песочницы видит всё:
 * иначе некому смотреть на картину целиком.
 */
import { ADMINS } from '@sandbox/manifest';
import { registry } from './config.ts';
import { service } from './db.ts';
import { SERVICE_ACTORS } from './platform.ts';
import { canUse } from './access.ts';

/** Тулы, доступные человеку: проверяем тем же правилом, что пускает в сам тул. */
export async function visibleTools(viewer: { actor: string; groups: string[] }): Promise<string[]> {
  const { rows } = await service.query<{ name: string; owner: string }>(
    "SELECT name, owner FROM gateway.tools WHERE revoked_at IS NULL AND name NOT LIKE '%--%'",
  );
  const out: string[] = [];
  for (const t of rows) {
    if ((await canUse(t.name, { actor: viewer.actor, groups: viewer.groups, channel: 'web' }, t.owner)).allowed) out.push(t.name);
  }
  return out;
}

const APPLIED = ['write.apply', 'write.commit', 'write.commit_approved'];
/** Тулы конвейера: хоть раз допущены деплоером (прод или превью). До шага 0 выкатывал CI — его допуски учитываем в датах. */
const PIPELINE = `(SELECT DISTINCT split_part(tool, '--', 1) FROM audit.calls WHERE operation = 'tool.register' AND allowed AND actor = 'deployer')`;
const DEPLOYERS = `actor IN ('deployer', 'ci')`;
const HUMAN = `allowed AND NOT (actor = ANY($1)) AND tool IN ${PIPELINE}`;

export async function metrics(viewer?: { actor: string; groups: string[] }) {
  const visible = viewer && !viewer.groups.includes(ADMINS) ? new Set(await visibleTools(viewer)) : null;
  const allowed = (tool: string) => !visible || visible.has(tool.split('--')[0]!);

  const [lives, firsts, weekly, tools, sources, people, denials] = await Promise.all([
    // Жизни прод-тулов: живые и умершие (строка ещё в gateway.tools) + уже убранные в историю.
    service.query<{ name: string; owner: string; born_at: Date; ended_at: Date | null; end_reason: string | null; sources: string[]; writes: string[] }>(
      `WITH lives AS (
         SELECT name, owner, registered_at AS born_at,
                CASE WHEN revoked_at IS NOT NULL THEN revoked_at WHEN expires_at <= now() THEN expires_at END AS ended_at,
                CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN
                     CASE WHEN idle_notified_at IS NOT NULL THEN 'idle' ELSE 'expired' END END AS end_reason,
                manifest
           FROM gateway.tools
         UNION ALL
         SELECT name, owner, born_at, ended_at, end_reason, manifest FROM gateway.tool_history
       )
       SELECT name, owner, born_at, ended_at, end_reason,
              ARRAY(SELECT jsonb_array_elements_text(manifest->'sources')) AS sources,
              ARRAY(SELECT jsonb_array_elements_text(manifest->'writes'))  AS writes
         FROM lives WHERE name IN ${PIPELINE}
        ORDER BY born_at`,
    ),
    // Первое превью и первый прод каждого тула — из аудита допуска (он хранится всегда).
    service.query<{ tool: string; first_preview: Date | null; first_prod: Date | null }>(
      `SELECT split_part(tool, '--', 1) AS tool,
              min(at) FILTER (WHERE tool LIKE '%--%')     AS first_preview,
              min(at) FILTER (WHERE tool NOT LIKE '%--%') AS first_prod
         FROM audit.calls WHERE operation = 'tool.register' AND allowed AND ${DEPLOYERS}
          AND split_part(tool, '--', 1) IN ${PIPELINE}
        GROUP BY 1`,
    ),
    // Использование людьми по неделям, 12 недель.
    service.query<{ week: Date; people: number; person_days: number; calls: number; via_agent: number; writes: number; tools: number }>(
      `SELECT date_trunc('week', at) AS week,
              count(DISTINCT actor)::int AS people,
              count(DISTINCT (actor, at::date))::int AS person_days,
              count(*)::int AS calls,
              count(*) FILTER (WHERE agent_in_chain)::int AS via_agent,
              count(*) FILTER (WHERE operation = ANY($2))::int AS writes,
              count(DISTINCT tool)::int AS tools
         FROM audit.calls WHERE ${HUMAN} AND at > now() - interval '12 weeks'
        GROUP BY 1 ORDER BY 1`,
      [SERVICE_ACTORS, APPLIED],
    ),
    // По тулам за 30 дней.
    service.query<{ tool: string; people: number; person_days: number; calls: number; writes: number; last_at: Date }>(
      `SELECT tool, count(DISTINCT actor)::int AS people, count(DISTINCT (actor, at::date))::int AS person_days,
              count(*)::int AS calls, count(*) FILTER (WHERE operation = ANY($2))::int AS writes, max(at) AS last_at
         FROM audit.calls WHERE ${HUMAN} AND at > now() - interval '30 days'
        GROUP BY 1 ORDER BY person_days DESC, calls DESC`,
      [SERVICE_ACTORS, APPLIED],
    ),
    // По источникам за 30 дней: у чтения в source — источник, у записи — id права (источник берём из реестра).
    service.query<{ source: string; operation: string; tools: string[]; people: number; calls: number }>(
      `SELECT source, CASE WHEN operation = ANY($2) THEN 'write' ELSE 'read' END AS operation,
              array_agg(DISTINCT tool) AS tools, count(DISTINCT actor)::int AS people, count(*)::int AS calls
         FROM audit.calls WHERE ${HUMAN} AND at > now() - interval '30 days' AND source IS NOT NULL
          AND (operation LIKE 'query%' OR operation = ANY($2))
        GROUP BY 1, 2`,
      [SERVICE_ACTORS, APPLIED],
    ),
    // Кто пользуется песочницей за 30 дней: людям нужен разрез «по людям», а не только «по тулам».
    service.query<{ actor: string; tools: number; calls: number; writes: number; person_days: number; last_at: Date }>(
      `SELECT actor, count(DISTINCT tool)::int AS tools, count(*)::int AS calls,
              count(*) FILTER (WHERE operation = ANY($2))::int AS writes,
              count(DISTINCT at::date)::int AS person_days, max(at) AS last_at
         FROM audit.calls WHERE ${HUMAN} AND at > now() - interval '30 days'
        GROUP BY 1 ORDER BY calls DESC LIMIT 50`,
      [SERVICE_ACTORS, APPLIED],
    ),
    // Отказы с причинами: чаще всего это не поломка, а непонятная человеку граница — её и надо увидеть.
    service.query<{ tool: string; reason: string | null; calls: number; people: number; last_at: Date }>(
      `SELECT split_part(tool, '--', 1) AS tool, reason, count(*)::int AS calls,
              count(DISTINCT actor)::int AS people, max(at) AS last_at
         FROM audit.calls
        WHERE NOT allowed AND NOT (actor = ANY($1)) AND at > now() - interval '30 days'
          AND split_part(tool, '--', 1) IN ${PIPELINE}
        GROUP BY 1, 2 ORDER BY calls DESC LIMIT 20`,
      [SERVICE_ACTORS],
    ),
  ]);

  const bySource = new Map<string, { source: string; title: string; reads: number; writes: number; people: number; tools: Set<string> }>();
  for (const r of sources.rows) {
    const id = r.operation === 'write' ? registry.writes[r.source]?.source ?? r.source : r.source;
    const s = bySource.get(id) ?? { source: id, title: registry.sources[id]?.title ?? id, reads: 0, writes: 0, people: 0, tools: new Set<string>() };
    if (r.operation === 'write') s.writes += r.calls;
    else s.reads += r.calls;
    s.people = Math.max(s.people, r.people);
    for (const t of r.tools) s.tools.add(t);
    bySource.set(id, s);
  }
  // Источники без обращений тоже показываем: одобрено, но не нужно — тоже ответ.
  for (const [id, s] of Object.entries(registry.sources)) {
    if (!bySource.has(id)) bySource.set(id, { source: id, title: s.title, reads: 0, writes: 0, people: 0, tools: new Set() });
  }
  const declared = (id: string) => lives.rows.filter((l) => !l.ended_at && l.sources.includes(id)).length;

  return {
    scope: visible ? 'ваши тулы' : 'все тулы',
    lives: lives.rows.filter((l) => allowed(l.name)),
    firsts: firsts.rows.filter((f) => allowed(f.tool)),
    weekly: weekly.rows,
    tools: tools.rows.filter((t) => allowed(t.tool)),
    people: people.rows,
    denials: denials.rows.filter((d) => allowed(d.tool)),
    sources: [...bySource.values()]
      .map((s) => ({ source: s.source, title: s.title, reads: s.reads, writes: s.writes, people: s.people, tools_used: s.tools.size, tools_declared: declared(s.source) }))
      .sort((a, b) => b.reads + b.writes - (a.reads + a.writes)),
  };
}
