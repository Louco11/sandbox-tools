/** Источник knowledge-readonly: база знаний, только дописывается. */
import { clip, type PgWriteHandler } from '../util.ts';

const KIND: Record<string, string> = { note: 'заметку', decision: 'решение', summary: 'итог', article: 'статью' };

export const writes: Record<string, PgWriteHandler> = {
  'knowledge.note:create': {
    async describe(_db, p) {
      const where = p.task_id !== undefined ? ` к задаче #${p.task_id}` : '';
      const tags = p.tags ? ` [${p.tags}]` : '';
      return `Добавить в базу знаний ${KIND[p.kind!]}${where}: «${clip(String(p.title))}»${tags}. ${clip(String(p.body), 300)}`;
    },
    async apply(db, p, { decidedBy, agent }) {
      const tags = String(p.tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).join(',');
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO knowledge.notes (task_id, kind, title, body, tags, author, agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [p.task_id ?? null, p.kind, p.title, p.body, tags, decidedBy, agent],
      );
      return { note_id: rows[0]!.id };
    },
  },
};

// Что читает и под какими ролями БД пишет коннектор. Роль — одна на право записи, с минимальными грантами
// (infra/postgres/init). Пароли — в окружении этого коннектора, у гейтвея их больше нет.
export const read = {"role":"src_knowledge_readonly","password_env":"PG_KNOWLEDGE_READONLY_PASSWORD"};
export const datasets: Record<string, { table: string; columns: string[] }> = {
  "notes": {
    "table": "knowledge.notes",
    "columns": [
      "id",
      "task_id",
      "kind",
      "title",
      "body",
      "tags",
      "author",
      "agent",
      "created_at"
    ]
  }
};
export const roles: Record<string, { role: string; password_env: string }> = {
  "knowledge.note:create": {
    "role": "src_knowledge_note_create",
    "password_env": "PG_KNOWLEDGE_NOTE_CREATE_PASSWORD"
  }
};
