import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export const SENSITIVITY = ['public', 'internal', 'confidential', 'personal'] as const;
export type Sensitivity = (typeof SENSITIVITY)[number];

const approval = {
  title: z.string(),
  owner: z.string(),
  approved_by: z.string(),
  approved_at: z.string(),
};

/**
 * Коннектор — сервис источника за гейтвеем (им владеет команда данных). Гейтвей проверяет скоуп, параметры
 * и пишет аудит, а читает и пишет коннектор: POST /query, /writes/<id>/describe, /writes/<id>/apply.
 */
const connector = z.object({
  url: z.string().url(),
  /** Переменная окружения гейтвея с токеном, по которому коннектор узнаёт гейтвей. */
  token_env: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
});

/**
 * Фильтр строк (шаг Б5): человек видит не весь набор, а свои строки — «свой отдел», «свои заказы».
 * Условие задаёт хранитель данных в реестре, гейтвей подставляет его по группам человека.
 */
const rowFilter = z.object({
  field: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  /** Группа → какие значения поля ей видны. */
  by_group: z.record(z.string(), z.array(z.union([z.string(), z.number()]))).default({}),
  /** Кому фильтр не применяется: руководитель направления, аудит. */
  unrestricted_groups: z.array(z.string()).default([]),
});

/** Набор данных — имя у коннектора: таблиц, запросов и ролей гейтвей не знает, это дело коннектора. */
const dataset = z.object({
  description: z.string(),
  fields: z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), z.enum(SENSITIVITY)),
  row_filter: rowFilter.optional(),
});

const param = z.discriminatedUnion('type', [
  z.object({ type: z.literal('integer'), description: z.string().optional(), required: z.boolean().default(true) }),
  z.object({ type: z.literal('string'), description: z.string().optional(), required: z.boolean().default(true) }),
  z.object({ type: z.literal('enum'), values: z.array(z.string()).min(1), description: z.string().optional(), required: z.boolean().default(true) }),
]);

export const registrySchema = z.object({
  version: z.literal(1),
  policy: z.object({
    max_ttl_days: z.number().int().positive(),
    token_ttl_seconds: z.number().int().positive(),
    max_rows: z.number().int().positive(),
    write_confirmation_ttl_seconds: z.number().int().positive(),
    /** Простой без вызовов человека, после которого владелец получает уведомление. */
    idle_days: z.number().int().positive().default(30),
    /** Сколько дней после уведомления о простое тул ещё живёт. */
    idle_grace_days: z.number().int().positive().default(7),
  }),
  sources: z.record(z.string(), z.object({
    ...approval,
    /** Источник — всегда коннектор: сервис за гейтвеем в сети sources (connectors/<источник>). */
    kind: z.literal('connector').default('connector'),
    connector,
    /**
     * Кому хранитель данных разрешил видеть источник (шаг Б4). Пусто — ограничения нет.
     * Тул не может открыть свои данные группам шире этого списка: проверяют CI и гейтвей.
     */
    allowed_groups: z.array(z.string()).default([]),
    /**
     * Кому видны чувствительные поля (шаг Б5): уровень → группы. Уровень не указан — поле видно всем,
     * кому открыт источник. Остальным поле приходит пустым и помечается — тул не падает, но данных не получает.
     */
    field_groups: z.partialRecord(z.enum(SENSITIVITY), z.array(z.string())).default({}),
    datasets: z.record(z.string(), dataset),
  })),
  writes: z.record(z.string(), z.object({
    ...approval,
    /** Источник, чей коннектор описывает и выполняет запись. */
    source: z.string(),
    /** Важное действие (удаление, списание): и в UI применяется только после явного подтверждения человеком. */
    confirm: z.boolean().default(false),
    params: z.record(z.string(), param),
  })),
}).superRefine((r, ctx) => {
  for (const [id, w] of Object.entries(r.writes)) {
    if (!r.sources[w.source]) ctx.addIssue({ code: 'custom', path: ['writes', id, 'source'], message: `источник «${w.source}» не найден в реестре` });
  }
});

export type Registry = z.infer<typeof registrySchema>;
export type SourceDef = Registry['sources'][string];
export type DatasetDef = SourceDef['datasets'][string];
export type WriteDef = Registry['writes'][string];
export type ParamDef = WriteDef['params'][string];

export function parseRegistry(text: string): Registry {
  const result = registrySchema.safeParse(parse(text));
  if (!result.success) {
    const details = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Реестр источников невалиден:\n${details}`);
  }
  return result.data;
}

export function loadRegistry(path: string): Registry {
  return parseRegistry(readFileSync(path, 'utf8'));
}
