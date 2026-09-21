import { z } from 'zod';
import { registry } from './config.ts';
import { audit } from './audit.ts';
import { connectorQuery } from './connectors.ts';
import { badRequest, forbidden, notFound } from './errors.ts';
import type { CallContext } from './context.ts';

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const queryInputShape = {
  dataset: z.string().describe('Набор данных источника, например tasks'),
  fields: z.array(z.string()).optional().describe('Поля; по умолчанию все поля набора'),
  where: z
    .array(
      z.object({
        field: z.string(),
        op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']),
        value: z.union([scalar, z.array(scalar)]),
      }),
    )
    .optional()
    .describe('Условия, объединяются через AND'),
  order_by: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).default('asc') }).optional(),
  limit: z.number().int().positive().optional(),
};
export const queryInputSchema = z.object(queryInputShape).strict();
export type QueryInput = z.infer<typeof queryInputSchema>;

/**
 * Какие чувствительные поля человеку не видны (шаг Б5): уровень поля есть в field_groups источника,
 * а человек не в этих группах. Поле приходит пустым и помечается — тул не падает, но данных не получает.
 */
function redactedFields(source: (typeof registry)['sources'][string], fields: string[], dsFields: Record<string, string>, groups: string[]): string[] {
  return fields.filter((f) => {
    const allowed = source.field_groups[dsFields[f] as keyof typeof source.field_groups];
    return Boolean(allowed?.length) && !allowed!.some((g) => groups.includes(g));
  });
}

/**
 * Чтение набора данных источника. Скоуп, набор, поля, условия и лимит проверяются здесь по реестру; коннектор
 * получает уже проверенный запрос и сам решает, как выполнить его в своей системе (SQL, API, MCP).
 * Что из этого человеку видно — тоже решает гейтвей: чувствительные поля по группам и фильтр строк из реестра.
 */
export async function runQuery(ctx: CallContext, sourceId: string, raw: unknown) {
  const base = { requestId: ctx.requestId, actor: ctx.actor, tool: ctx.tool, source: sourceId, agentInChain: ctx.agent !== null };
  const deny = async (err: Error, operation = 'query') => {
    await audit({ ...base, operation, allowed: false, reason: err.message });
    return err;
  };

  const source = registry.sources[sourceId];
  if (!source) throw await deny(notFound(`источник «${sourceId}» не найден в реестре`));
  if (!ctx.manifest.sources.includes(sourceId)) {
    throw await deny(forbidden(`источник «${sourceId}» не объявлен в tool.yaml тула ${ctx.tool}`));
  }

  const parsed = queryInputSchema.safeParse(raw);
  if (!parsed.success) throw await deny(badRequest('некорректный запрос', parsed.error.issues));
  const q = parsed.data;
  const operation = `query:${q.dataset}`;

  const ds = source.datasets[q.dataset];
  if (!ds) {
    throw await deny(notFound(`в источнике «${sourceId}» нет набора «${q.dataset}». Есть: ${Object.keys(source.datasets).join(', ')}`), operation);
  }

  const known = Object.keys(ds.fields);
  const fields = q.fields?.length ? q.fields : known;
  const whereFields = q.where?.map((w) => w.field) ?? [];
  const unknown = [...fields, ...whereFields, ...(q.order_by ? [q.order_by.field] : [])].filter((f) => !known.includes(f));
  if (unknown.length) {
    throw await deny(badRequest(`в наборе «${q.dataset}» нет полей: ${[...new Set(unknown)].join(', ')}. Есть: ${known.join(', ')}`), operation);
  }
  if ((q.limit ?? 0) > registry.policy.max_rows) {
    throw await deny(badRequest(`limit больше ${registry.policy.max_rows}`), operation);
  }

  for (const w of q.where ?? []) {
    if (w.op === 'in' && !Array.isArray(w.value)) throw await deny(badRequest(`для op=in нужен массив (${w.field})`), operation);
    if (w.op !== 'in' && Array.isArray(w.value)) throw await deny(badRequest(`массив допустим только для op=in (${w.field})`), operation);
  }
  const touched = [...new Set([...fields, ...whereFields])];
  const limit = q.limit ?? registry.policy.max_rows;

  // Фильтр строк: человек видит свои строки. Условие задал хранитель данных в реестре, подставляем по группам.
  const where = [...(q.where ?? [])];
  const filter = ds.row_filter;
  let rowScope: string | null = null;
  if (filter && !filter.unrestricted_groups.some((g) => ctx.groups.includes(g))) {
    const values = [...new Set(ctx.groups.flatMap((g) => filter.by_group[g] ?? []))];
    if (!values.length) {
      throw await deny(forbidden(
        `в наборе «${q.dataset}» видны только свои строки по полю «${filter.field}», а у вас нет группы, которой они назначены. `
        + `Группы задаёт хранитель источника «${sourceId}»`,
      ), operation);
    }
    where.push({ field: filter.field, op: 'in' as const, value: values });
    rowScope = `${filter.field}: ${values.join(', ')}`;
  }

  const redacted = redactedFields(source, fields, ds.fields, ctx.groups);
  const result = (rows: Record<string, unknown>[]) => ({
    source: sourceId,
    dataset: q.dataset,
    fields: Object.fromEntries(fields.map((f) => [f, ds.fields[f]])),
    row_count: rows.length,
    // Чего человек не увидит и почему — говорим вслух: пустое поле не должно выглядеть пустыми данными.
    ...(redacted.length ? { redacted, redacted_reason: `поля ${redacted.join(', ')} видны только группам, которые назвал хранитель источника` } : {}),
    ...(rowScope ? { row_scope: rowScope } : {}),
    rows: redacted.length ? rows.map((r) => ({ ...r, ...Object.fromEntries(redacted.map((f) => [f, null])) })) : rows,
  });

  await audit({
    ...base, operation, fields: touched, allowed: true,
    reason: [redacted.length ? `скрыты поля: ${redacted.join(', ')}` : '', rowScope ? `строки: ${rowScope}` : ''].filter(Boolean).join('; ') || undefined,
  });
  return result(await connectorQuery(source, sourceId, { dataset: q.dataset, fields, where, order_by: q.order_by, limit }));
}
