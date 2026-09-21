import { parse } from 'yaml';
import { z } from 'zod';
import type { Registry } from './registry.ts';

export const UI_MODES = ['web', 'mcp-app'] as const;

/**
 * Право записи в манифесте бывает двух видов (шаг Б5):
 *   - tasks.task:create                       — всем, кому открыт тул;
 *   - pastry.stock:adjust: { groups: [...] }  — только этим группам; кнопку остальным не показываем, а гейтвей
 *                                               всё равно проверяет на apply и commit.
 * Разбираем это до схемы: дальше по коду writes — плоский список, а ограничения лежат отдельно.
 */
function splitWrites(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const input = raw as Record<string, unknown>;
  if (!Array.isArray(input.writes)) return raw;
  const writes: string[] = [];
  const write_groups: Record<string, string[]> = {};
  for (const item of input.writes) {
    if (typeof item === 'string') {
      writes.push(item);
      continue;
    }
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return raw; // пусть ругается схема
    for (const [id, spec] of Object.entries(item as Record<string, unknown>)) {
      writes.push(id);
      const groups = (spec as { groups?: unknown } | null)?.groups;
      if (Array.isArray(groups)) write_groups[id] = groups.map(String);
    }
  }
  return { ...input, writes, ...(Object.keys(write_groups).length ? { write_groups } : {}) };
}

// Форма манифеста. Сверка с реестром — отдельно, в validateManifest.
export const manifestSchema = z.preprocess(splitWrites, z
  .object({
    name: z
      .string()
      .min(3)
      .max(40)
      .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'slug: латиница в нижнем регистре, цифры и одиночный дефис, 3–40 символов'),
    owner: z.string().min(2, 'владелец — живой человек, укажите логин'),
    ttl_days: z.number().int().positive(),
    sources: z.array(z.string()).default([]),
    writes: z.array(z.string()).default([]),
    /** Права записи, ограниченные группами: id права → группы, которым она разрешена. */
    write_groups: z.record(z.string(), z.array(z.string())).default({}),
    ui: z.object({ mode: z.array(z.enum(UI_MODES)).min(1) }).strict(),
    /**
     * Кому доступен тул (шаг Б4). Раздела нет — только владелец: тул не открывается всем по умолчанию.
     * Группы обязаны укладываться в allowed_groups каждого источника — это решение хранителя данных.
     */
    access: z
      .object({
        groups: z.array(z.string()).default([]),
        /** Люди-исключения: подрядчик, стажёр — когда заводить группу ради одного человека незачем. */
        people: z.array(z.string()).default([]),
        /** Можно ли подключать тул агентом (MCP). По умолчанию да: это второй фасад того же тула. */
        agents: z.boolean().default(true),
      })
      .strict()
      .default({ groups: [], people: [], agents: true }),
  })
  .strict());

export type Manifest = z.infer<typeof manifestSchema>;

export interface ManifestError {
  path: string;
  message: string;
}

export type ManifestResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: ManifestError[] };

/**
 * Проверяет манифест против реестра одобренных источников.
 * Это и есть контракт допуска: сообщения об ошибках объясняют, почему нельзя и что делать.
 */
export function validateManifest(input: unknown, registry: Registry): ManifestResult {
  const shape = manifestSchema.safeParse(input);
  if (!shape.success) {
    return {
      ok: false,
      errors: shape.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message })),
    };
  }

  const m = shape.data;
  const errors: ManifestError[] = [];
  const approvedSources = Object.keys(registry.sources);
  const approvedWrites = Object.keys(registry.writes);

  if (m.ttl_days > registry.policy.max_ttl_days) {
    errors.push({
      path: 'ttl_days',
      message: `${m.ttl_days} дней больше лимита ${registry.policy.max_ttl_days}. Тул, которому нужно дольше, продлевается владельцем, а не получает большой TTL заранее`,
    });
  }

  // Источник ограничивает, кому его данные видны: группы тула должны укладываться в его allowed_groups.
  for (const source of m.sources) {
    const allowed = registry.sources[source]?.allowed_groups;
    if (!allowed?.length) continue;
    const extra = m.access.groups.filter((g) => !allowed.includes(g));
    if (extra.length) {
      errors.push({
        path: 'access.groups',
        message: `источник «${source}» открыт только группам ${allowed.join(', ')}; ${extra.join(', ')} туда не входят. `
          + 'Расширить круг может хранитель данных в реестре, а не манифест тула',
      });
    }
  }

  m.sources.forEach((s, i) => {
    if (!approvedSources.includes(s)) {
      errors.push({
        path: `sources[${i}]`,
        message: `источник «${s}» не одобрен. Одобренные: ${approvedSources.join(', ')}. Новый источник добавляется в registry/sources.yaml решением ИБ и владельца данных, не правкой манифеста`,
      });
    }
  });

  m.writes.forEach((w, i) => {
    if (!approvedWrites.includes(w)) {
      errors.push({
        path: `writes[${i}]`,
        message: `право на запись «${w}» не одобрено. Одобренные: ${approvedWrites.join(', ') || 'нет'}`,
      });
    }
  });

  for (const [list, key] of [[m.sources, 'sources'], [m.writes, 'writes']] as const) {
    const dup = list.filter((v, i) => list.indexOf(v) !== i);
    if (dup.length) errors.push({ path: key, message: `повторяются: ${[...new Set(dup)].join(', ')}` });
  }

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m };
}

export function parseManifestYaml(text: string, registry: Registry): ManifestResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: '(yaml)', message: (e as Error).message }] };
  }
  return validateManifest(raw, registry);
}
