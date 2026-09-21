import type { z } from 'zod';
import type { AppliedWrite, PreparedWrite, QueryInput, QueryResult, WriteResult } from './gateway.ts';

/** Всё, что доступно обработчику действия. Другого пути к данным у тула нет. */
export interface ActionContext {
  /** Живой человек, от имени которого выполняется действие. */
  actor: string;
  /** Агент в цепочке решения; null — действие инициировал человек. */
  agent: string | null;
  query<Row = Record<string, unknown>>(source: string, dataset: string, q?: QueryInput): Promise<QueryResult<Row>>;
  /**
   * Запись через гейтвей. В UI (без агента) применяется сразу (`done`).
   * С агентом — только подготовка; человек подтверждает `commit_write` в хосте.
   */
  prepareWrite(write: string, params: Record<string, string | number>): Promise<WriteResult>;
}

export type { AppliedWrite, PreparedWrite, WriteResult };

export interface ActionDef<Shape extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  input: Shape;
  handler: (input: z.infer<z.ZodObject<Shape>>, ctx: ActionContext) => Promise<unknown>;
}

export interface ToolDef {
  title: string;
  description: string;
  actions: Record<string, ActionDef<any>>;
}

/** Действие тула. Доступно из UI, а если UI открыт у агента — и самому агенту как MCP-инструмент. */
export function action<Shape extends z.ZodRawShape>(def: ActionDef<Shape>): ActionDef<Shape> {
  return def;
}

export function defineTool(def: ToolDef): ToolDef {
  return def;
}
