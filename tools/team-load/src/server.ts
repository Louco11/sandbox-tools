import { action, defineTool, startTool, z } from '@sandbox/sdk';

// Точка входа тула. Здесь только предметная логика: авторизация, доступ к данным,
// аудит, web и MCP App приходят из каркаса.
startTool(
  defineTool({
    title: 'Нагрузка по людям',
    description: 'Сколько открытых и просроченных задач у каждого человека в команде',
    actions: {
      list_items: action({
        description: 'Пример: первые записи набора tasks-readonly / tasks. Замените на свою логику',
        input: {
          limit: z.number().int().min(1).max(200).default(50),
        },
        handler: async ({ limit }, ctx) => {
          const res = await ctx.query('tasks-readonly', 'tasks', { limit });
          return { fields: res.fields, items: res.rows };
        },
      }),
    },
  }),
);
