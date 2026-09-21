import { action, defineTool, startTool, z } from '@sandbox/sdk';

// Точка входа тула. Здесь только предметная логика: авторизация, доступ к данным,
// аудит, web и MCP App приходят из каркаса.
startTool(
  defineTool({
    title: '__TITLE__',
    description: '__DESCRIPTION__',
    actions: {
      list_items: action({
        description: 'Пример: первые записи набора __EXAMPLE_SOURCE__ / __EXAMPLE_DATASET__. Замените на свою логику',
        input: {
          limit: z.number().int().min(1).max(200).default(50),
        },
        handler: async ({ limit }, ctx) => {
          const res = await ctx.query('__EXAMPLE_SOURCE__', '__EXAMPLE_DATASET__', { limit });
          return { fields: res.fields, items: res.rows };
        },
      }),
    },
  }),
);
