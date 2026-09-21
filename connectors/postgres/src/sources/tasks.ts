/** Источник tasks-readonly: доска задач команды и участники. */
import type pg from 'pg';
import { badRequest, checkDate, clip, notFound, type PgWriteHandler } from '../util.ts';

const PRIORITY: Record<string, string> = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочно' };
const STATUS: Record<string, string> = { inbox: 'Входящие', todo: 'К работе', in_progress: 'В работе', waiting: 'Ждём', done: 'Сделано' };

async function checkPerson(db: pg.Pool, name: string | number | undefined): Promise<void> {
  if (name === undefined) return;
  const { rows } = await db.query('SELECT 1 FROM tasks.people WHERE name = $1', [name]);
  if (!rows[0]) throw notFound(`в команде нет «${name}»`);
}

export const writes: Record<string, PgWriteHandler> = {
  'tasks.task:create': {
    async describe(db, p) {
      checkDate(p.due_at);
      await checkPerson(db, p.assignee);
      const parts = [`Создать задачу «${clip(String(p.title))}»`, `приоритет: ${PRIORITY[p.priority!]}`];
      parts.push(`колонка: ${STATUS[(p.status as string) ?? 'inbox']}`);
      if (p.assignee) parts.push(`исполнитель: ${p.assignee}`);
      if (p.project) parts.push(`проект: ${p.project}`);
      if (p.due_at) parts.push(`срок: ${p.due_at}`);
      return parts.join('; ');
    },
    async apply(db, p, { decidedBy }) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO tasks.tasks (title, description, status, priority, assignee, project, due_at, created_by)
         VALUES ($1, coalesce($2, ''), coalesce($3, 'inbox'), $4, $5, coalesce($6, 'Общее'), $7, $8)
         RETURNING id`,
        [p.title, p.description ?? null, p.status ?? null, p.priority, p.assignee ?? null, p.project ?? null, p.due_at ?? null, decidedBy],
      );
      return { task_id: rows[0]!.id };
    },
  },

  'tasks.task:update': {
    async describe(db, p) {
      const changes = (['status', 'priority', 'assignee', 'due_at'] as const).filter((k) => p[k] !== undefined);
      if (!changes.length) throw badRequest('нечего менять: укажите status, priority, assignee или due_at');
      checkDate(p.due_at);
      await checkPerson(db, p.assignee);
      const { rows } = await db.query<{ title: string; status: string; priority: string; assignee: string | null; due_at: Date | null }>(
        'SELECT title, status, priority, assignee, due_at FROM tasks.tasks WHERE id = $1',
        [p.task_id],
      );
      const t = rows[0];
      if (!t) throw notFound(`задача #${p.task_id} не найдена`);
      const was = { status: STATUS[t.status], priority: PRIORITY[t.priority], assignee: t.assignee ?? '—', due_at: t.due_at?.toISOString().slice(0, 10) ?? '—' };
      const now = { status: STATUS[p.status!], priority: PRIORITY[p.priority!], assignee: p.assignee, due_at: p.due_at };
      const label = { status: 'колонка', priority: 'приоритет', assignee: 'исполнитель', due_at: 'срок' };
      const diff = changes.map((k) => `${label[k]}: ${was[k]} → ${now[k]}`);
      return `Задача #${p.task_id} «${clip(t.title)}»: ${diff.join('; ')}`;
    },
    async apply(db, p) {
      const res = await db.query(
        `UPDATE tasks.tasks
            SET status   = coalesce($2, status),
                priority = coalesce($3, priority),
                assignee = coalesce($4, assignee),
                due_at   = coalesce($5::date, due_at),
                updated_at = now(),
                done_at  = CASE WHEN $2 = 'done' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE done_at END
          WHERE id = $1`,
        [p.task_id, p.status ?? null, p.priority ?? null, p.assignee ?? null, p.due_at ?? null],
      );
      if (res.rowCount !== 1) throw notFound(`задача #${p.task_id} не найдена`);
    },
  },
};

// Что читает и под какими ролями БД пишет коннектор. Роль — одна на право записи, с минимальными грантами
// (infra/postgres/init). Пароли — в окружении этого коннектора, у гейтвея их больше нет.
export const read = {"role":"src_tasks_readonly","password_env":"PG_TASKS_READONLY_PASSWORD"};
export const datasets: Record<string, { table: string; columns: string[] }> = {
  "tasks": {
    "table": "tasks.tasks",
    "columns": [
      "id",
      "title",
      "description",
      "status",
      "priority",
      "assignee",
      "project",
      "due_at",
      "created_by",
      "created_at",
      "updated_at",
      "done_at"
    ]
  },
  "people": {
    "table": "tasks.people",
    "columns": [
      "id",
      "name",
      "role",
      "team"
    ]
  }
};
export const roles: Record<string, { role: string; password_env: string }> = {
  "tasks.task:create": {
    "role": "src_tasks_create",
    "password_env": "PG_TASKS_CREATE_PASSWORD"
  },
  "tasks.task:update": {
    "role": "src_tasks_update",
    "password_env": "PG_TASKS_UPDATE_PASSWORD"
  }
};
