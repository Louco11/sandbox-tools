/** Источник boards-readonly: общие холсты тула whiteboard и история их публикаций. */
import { badRequest, clip, conflictError, inTransaction, notFound, plural, type PgWriteHandler } from '../util.ts';

// Доски: содержимое приходит JSON-строкой, человеку показываем не JSON, а что изменится на холсте.
const BOARD_MAX_BYTES = 200_000;
const BOARD_EL: Record<string, [string, string, string]> = {
  sticky: ['стикер', 'стикера', 'стикеров'],
  rect: ['прямоугольник', 'прямоугольника', 'прямоугольников'],
  ellipse: ['эллипс', 'эллипса', 'эллипсов'],
  diamond: ['ромб', 'ромба', 'ромбов'],
  text: ['текст', 'текста', 'текстов'],
  arrow: ['стрелка', 'стрелки', 'стрелок'],
  pen: ['рисунок', 'рисунка', 'рисунков'],
  chart: ['график', 'графика', 'графиков'],
};
type BoardEl = { id: string; type: string } & Record<string, unknown>;

function parseBoard(raw: string | number | undefined): { els: BoardEl[] } {
  const s = String(raw ?? '');
  if (Buffer.byteLength(s) > BOARD_MAX_BYTES) throw badRequest(`доска больше ${BOARD_MAX_BYTES / 1000} КБ — удалите лишние рисунки`);
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    throw badRequest('content: ожидается JSON');
  }
  const els = (v as { els?: unknown } | null)?.els;
  if (!Array.isArray(els)) throw badRequest('content: ожидается объект {"els": [...]}');
  const ids = new Set<string>();
  for (const e of els as BoardEl[]) {
    if (typeof e !== 'object' || e === null || typeof e.id !== 'string' || !(e.type in BOARD_EL)) {
      throw badRequest(`content: неизвестный элемент ${clip(JSON.stringify(e), 80)}`);
    }
    if (ids.has(e.id)) throw badRequest(`content: повторяется id элемента ${e.id}`);
    ids.add(e.id);
  }
  return { els: els as BoardEl[] };
}

function countByType(els: BoardEl[]): string {
  const n = new Map<string, number>();
  for (const e of els) n.set(e.type, (n.get(e.type) ?? 0) + 1);
  return [...n].map(([t, c]) => plural(c, BOARD_EL[t]!)).join(', ') || 'пустая';
}

function boardDiff(before: BoardEl[], after: BoardEl[]): string {
  const was = new Map(before.map((e) => [e.id, JSON.stringify(e)]));
  const now = new Set(after.map((e) => e.id));
  const added = after.filter((e) => !was.has(e.id));
  const removed = before.filter((e) => !now.has(e.id));
  const changed = after.filter((e) => was.has(e.id) && was.get(e.id) !== JSON.stringify(e)).length;
  const parts = [];
  if (added.length) parts.push(`добавить ${countByType(added)}`);
  if (removed.length) parts.push(`удалить ${countByType(removed)}`);
  if (changed) parts.push(`изменить ${plural(changed, ['элемент', 'элемента', 'элементов'])}`);
  return parts.join('; ') || 'без изменений в элементах';
}

const conflict = (b: { version: number; updated_by: string; updated_at: Date }, base: string | number | undefined) =>
  conflictError(
    `доску уже обновил ${b.updated_by} ${b.updated_at.toISOString().slice(0, 16).replace('T', ' ')} UTC (версия ${b.version}, ваша правка начата с ${base}). Откройте свежую версию`,
  );

export const writes: Record<string, PgWriteHandler> = {
  'boards.board:create': {
    async describe(_db, p) {
      const { els } = parseBoard(p.content);
      return `Опубликовать новую общую доску «${clip(String(p.name))}»: ${countByType(els)}. Её увидят и смогут править все, у кого есть доступ к тулу`;
    },
    async apply(db, p, { decidedBy }) {
      const content = JSON.stringify(parseBoard(p.content));
      return inTransaction(db, async (c) => {
        const { rows } = await c.query<{ id: number }>(
          'INSERT INTO boards.boards (name, content, created_by, updated_by) VALUES ($1, $2, $3, $3) RETURNING id',
          [p.name, content, decidedBy],
        );
        const id = rows[0]!.id;
        await c.query(
          'INSERT INTO boards.versions (board_id, version, name, content, saved_by, note) VALUES ($1, 1, $2, $3, $4, $5)',
          [id, p.name, content, decidedBy, p.note ?? ''],
        );
        return { board_id: id, version: 1 };
      });
    },
  },

  'boards.board:save': {
    async describe(db, p) {
      const { els } = parseBoard(p.content);
      const { rows } = await db.query<{ name: string; content: { els: BoardEl[] }; version: number; updated_by: string; updated_at: Date }>(
        'SELECT name, content, version, updated_by, updated_at FROM boards.boards WHERE id = $1',
        [p.board_id],
      );
      const b = rows[0];
      if (!b) throw notFound(`доска #${p.board_id} не найдена`);
      if (b.version !== p.base_version) throw conflict(b, p.base_version);
      const rename = p.name !== undefined && p.name !== b.name ? `; переименовать в «${clip(String(p.name))}»` : '';
      return `Доска «${clip(b.name)}», версия ${b.version} → ${b.version + 1}: ${boardDiff(b.content.els ?? [], els)}${rename}`;
    },
    async apply(db, p, { decidedBy }) {
      const content = JSON.stringify(parseBoard(p.content));
      return inTransaction(db, async (c) => {
        // Версия проверяется ещё раз в момент записи: между подготовкой и подтверждением доску могли обновить.
        const { rows } = await c.query<{ name: string; version: number }>(
          `UPDATE boards.boards
              SET content = $3, name = coalesce($4, name), version = version + 1, updated_by = $5, updated_at = now()
            WHERE id = $1 AND version = $2
            RETURNING name, version`,
          [p.board_id, p.base_version, content, p.name ?? null, decidedBy],
        );
        const saved = rows[0];
        if (!saved) {
          const cur = await c.query<{ version: number; updated_by: string; updated_at: Date }>(
            'SELECT version, updated_by, updated_at FROM boards.boards WHERE id = $1',
            [p.board_id],
          );
          if (!cur.rows[0]) throw notFound(`доска #${p.board_id} не найдена`);
          throw conflict(cur.rows[0], p.base_version);
        }
        await c.query(
          'INSERT INTO boards.versions (board_id, version, name, content, saved_by, note) VALUES ($1, $2, $3, $4, $5, $6)',
          [p.board_id, saved.version, saved.name, content, decidedBy, p.note ?? ''],
        );
        return { board_id: p.board_id, version: saved.version };
      });
    },
  },
};

// Что читает и под какими ролями БД пишет коннектор. Роль — одна на право записи, с минимальными грантами
// (infra/postgres/init). Пароли — в окружении этого коннектора, у гейтвея их больше нет.
export const read = {"role":"src_boards_readonly","password_env":"PG_BOARDS_READONLY_PASSWORD"};
export const datasets: Record<string, { table: string; columns: string[] }> = {
  "boards": {
    "table": "boards.boards",
    "columns": [
      "id",
      "name",
      "content",
      "version",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at"
    ]
  },
  "versions": {
    "table": "boards.versions",
    "columns": [
      "board_id",
      "version",
      "name",
      "content",
      "saved_by",
      "saved_at",
      "note"
    ]
  }
};
export const roles: Record<string, { role: string; password_env: string }> = {
  "boards.board:create": {
    "role": "src_boards_create",
    "password_env": "PG_BOARDS_CREATE_PASSWORD"
  },
  "boards.board:save": {
    "role": "src_boards_save",
    "password_env": "PG_BOARDS_SAVE_PASSWORD"
  }
};
