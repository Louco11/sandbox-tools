/** Источник pastry-readonly: кондитерская — клиенты, заказы, каталог тортов, рецепты и склад. */
import type pg from 'pg';
import { badRequest, checkDate, checkTime, clip, inTransaction, notFound, plural, type PgWriteHandler, type SqlClient } from '../util.ts';

const ORDER_STATUS: Record<string, string> = {
  new: 'новый',
  confirmed: 'подтверждён',
  baking: 'в готовке',
  ready: 'готов',
  delivered: 'выдан',
  cancelled: 'отменён',
};


/** Сколько ингредиентов нужно на заказ: ceil(qty_per_kg × weight_g / 1000). */
async function bakingPlan(db: SqlClient, orderId: number) {
  const { rows } = await db.query<{
    status: string;
    stock_deducted: boolean;
    weight_g: number;
    cake: string;
    client: string;
    cake_type_id: number;
  }>(
    `SELECT o.status, o.stock_deducted, o.weight_g, ct.name AS cake, cl.name AS client, o.cake_type_id
       FROM pastry.orders o
       JOIN pastry.cake_types ct ON ct.id = o.cake_type_id
       JOIN pastry.clients cl ON cl.id = o.client_id
      WHERE o.id = $1`,
    [orderId],
  );
  const o = rows[0];
  if (!o) throw notFound(`заказ #${orderId} не найден`);
  if (o.stock_deducted) throw badRequest(`заказ #${orderId}: ингредиенты уже списаны`);
  if (o.status !== 'new' && o.status !== 'confirmed') {
    throw badRequest(`заказ #${orderId} в статусе «${ORDER_STATUS[o.status] ?? o.status}» — в готовку нельзя`);
  }
  const recipe = await db.query<{ ingredient_id: number; name: string; unit: string; qty_per_kg: number; stock_qty: number }>(
    `SELECT r.ingredient_id, i.name, i.unit, r.qty_per_kg, i.stock_qty
       FROM pastry.recipe_lines r
       JOIN pastry.ingredients i ON i.id = r.ingredient_id
      WHERE r.cake_type_id = $1`,
    [o.cake_type_id],
  );
  if (!recipe.rows.length) throw badRequest(`у торта «${o.cake}» пустой рецепт — сначала задайте состав на 1 кг`);
  const needs = recipe.rows.map((r) => {
    const need = Math.ceil((r.qty_per_kg * o.weight_g) / 1000);
    return {
      ingredient_id: r.ingredient_id,
      name: r.name,
      unit: r.unit,
      need,
      stock: r.stock_qty,
      ok: r.stock_qty >= need,
    };
  });
  const short = needs.filter((n) => !n.ok).map((n) => `${n.name}: нужно ${n.need} ${n.unit}, есть ${n.stock}`);
  return {
    cake: o.cake,
    client: o.client,
    kg: (o.weight_g / 1000).toFixed(2).replace(/\.?0+$/, ''),
    needs,
    short,
  };
}

export const writes: Record<string, PgWriteHandler> = {
  'pastry.client:create': {
    async describe(_db, p) {
      const parts = [`Добавить клиента «${clip(String(p.name))}»`];
      if (p.phone) parts.push(`тел. ${p.phone}`);
      if (p.email) parts.push(`email ${p.email}`);
      return parts.join('; ');
    },
    async apply(db, p) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO pastry.clients (name, phone, email, notes)
         VALUES ($1, coalesce($2, ''), coalesce($3, ''), coalesce($4, '')) RETURNING id`,
        [p.name, p.phone ?? null, p.email ?? null, p.notes ?? null],
      );
      return { client_id: rows[0]!.id };
    },
  },

  'pastry.client:update': {
    async describe(db, p) {
      const changes = (['name', 'phone', 'email', 'notes'] as const).filter((k) => p[k] !== undefined);
      if (!changes.length) throw badRequest('нечего менять');
      const { rows } = await db.query<{ name: string }>('SELECT name FROM pastry.clients WHERE id = $1', [p.client_id]);
      if (!rows[0]) throw notFound(`клиент #${p.client_id} не найден`);
      return `Клиент #${p.client_id} «${clip(rows[0].name)}»: изменить ${changes.join(', ')}`;
    },
    async apply(db, p) {
      const res = await db.query(
        `UPDATE pastry.clients SET
           name = coalesce($2, name),
           phone = coalesce($3, phone),
           email = coalesce($4, email),
           notes = coalesce($5, notes),
           updated_at = now()
         WHERE id = $1`,
        [p.client_id, p.name ?? null, p.phone ?? null, p.email ?? null, p.notes ?? null],
      );
      if (res.rowCount !== 1) throw notFound(`клиент #${p.client_id} не найден`);
    },
  },

  'pastry.cake_type:create': {
    async describe(_db, p) {
      if (!Number.isInteger(p.price_per_kg) || (p.price_per_kg as number) < 0) throw badRequest('price_per_kg: неотрицательное целое');
      return `Добавить в каталог «${clip(String(p.name))}», ${p.price_per_kg} ₽/кг`;
    },
    async apply(db, p) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO pastry.cake_types (name, price_per_kg, notes)
         VALUES ($1, $2, coalesce($3, '')) RETURNING id`,
        [p.name, p.price_per_kg, p.notes ?? null],
      );
      return { cake_type_id: rows[0]!.id };
    },
  },

  'pastry.cake_type:update': {
    async describe(db, p) {
      const changes = (['name', 'price_per_kg', 'active', 'notes'] as const).filter((k) => p[k] !== undefined);
      if (!changes.length) throw badRequest('нечего менять');
      const { rows } = await db.query<{ name: string }>('SELECT name FROM pastry.cake_types WHERE id = $1', [p.cake_type_id]);
      if (!rows[0]) throw notFound(`торт #${p.cake_type_id} не найден`);
      const bits = changes.map((k) => (k === 'active' ? `active → ${p.active}` : k));
      return `Торт #${p.cake_type_id} «${clip(rows[0].name)}»: ${bits.join(', ')}`;
    },
    async apply(db, p) {
      const active = p.active === undefined ? null : p.active === 'yes';
      const res = await db.query(
        `UPDATE pastry.cake_types SET
           name = coalesce($2, name),
           price_per_kg = coalesce($3, price_per_kg),
           active = coalesce($4, active),
           notes = coalesce($5, notes)
         WHERE id = $1`,
        [p.cake_type_id, p.name ?? null, p.price_per_kg ?? null, active, p.notes ?? null],
      );
      if (res.rowCount !== 1) throw notFound(`торт #${p.cake_type_id} не найден`);
    },
  },

  'pastry.recipe_line:upsert': {
    async describe(db, p) {
      if (!Number.isInteger(p.qty_per_kg) || (p.qty_per_kg as number) <= 0) throw badRequest('qty_per_kg: целое > 0');
      const [cake, ing] = await Promise.all([
        db.query<{ name: string }>('SELECT name FROM pastry.cake_types WHERE id = $1', [p.cake_type_id]),
        db.query<{ name: string; unit: string }>('SELECT name, unit FROM pastry.ingredients WHERE id = $1', [p.ingredient_id]),
      ]);
      if (!cake.rows[0]) throw notFound(`торт #${p.cake_type_id} не найден`);
      if (!ing.rows[0]) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
      return `Рецепт «${clip(cake.rows[0].name)}»: ${ing.rows[0].name} — ${p.qty_per_kg} ${ing.rows[0].unit} на 1 кг`;
    },
    async apply(db, p) {
      await db.query(
        `INSERT INTO pastry.recipe_lines (cake_type_id, ingredient_id, qty_per_kg)
         VALUES ($1, $2, $3)
         ON CONFLICT (cake_type_id, ingredient_id) DO UPDATE SET qty_per_kg = EXCLUDED.qty_per_kg`,
        [p.cake_type_id, p.ingredient_id, p.qty_per_kg],
      );
    },
  },

  'pastry.recipe_line:delete': {
    async describe(db, p) {
      const [cake, ing] = await Promise.all([
        db.query<{ name: string }>('SELECT name FROM pastry.cake_types WHERE id = $1', [p.cake_type_id]),
        db.query<{ name: string }>('SELECT name FROM pastry.ingredients WHERE id = $1', [p.ingredient_id]),
      ]);
      if (!cake.rows[0]) throw notFound(`торт #${p.cake_type_id} не найден`);
      if (!ing.rows[0]) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
      const { rows } = await db.query(
        'SELECT 1 FROM pastry.recipe_lines WHERE cake_type_id = $1 AND ingredient_id = $2',
        [p.cake_type_id, p.ingredient_id],
      );
      if (!rows[0]) throw notFound('такой строки в рецепте нет');
      return `Убрать из рецепта «${clip(cake.rows[0].name)}» ингредиент «${clip(ing.rows[0].name)}»`;
    },
    async apply(db, p) {
      const res = await db.query('DELETE FROM pastry.recipe_lines WHERE cake_type_id = $1 AND ingredient_id = $2', [
        p.cake_type_id,
        p.ingredient_id,
      ]);
      if (res.rowCount !== 1) throw notFound('такой строки в рецепте нет');
    },
  },

  'pastry.ingredient:create': {
    async describe(_db, p) {
      const stock = p.stock_qty ?? 0;
      const low = p.low_threshold ?? 0;
      if (!Number.isInteger(stock) || (stock as number) < 0) throw badRequest('stock_qty: неотрицательное целое');
      if (!Number.isInteger(low) || (low as number) < 0) throw badRequest('low_threshold: неотрицательное целое');
      return `Добавить на склад «${clip(String(p.name))}» (${p.unit}), остаток ${stock}, порог ${low}`;
    },
    async apply(db, p) {
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO pastry.ingredients (name, unit, stock_qty, low_threshold)
         VALUES ($1, $2, coalesce($3, 0), coalesce($4, 0)) RETURNING id`,
        [p.name, p.unit, p.stock_qty ?? null, p.low_threshold ?? null],
      );
      return { ingredient_id: rows[0]!.id };
    },
  },

  'pastry.ingredient:update': {
    async describe(db, p) {
      const changes = (['name', 'unit', 'low_threshold'] as const).filter((k) => p[k] !== undefined);
      if (!changes.length) throw badRequest('нечего менять');
      const { rows } = await db.query<{ name: string }>('SELECT name FROM pastry.ingredients WHERE id = $1', [p.ingredient_id]);
      if (!rows[0]) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
      return `Ингредиент #${p.ingredient_id} «${clip(rows[0].name)}»: ${changes.join(', ')}`;
    },
    async apply(db, p) {
      const res = await db.query(
        `UPDATE pastry.ingredients SET
           name = coalesce($2, name),
           unit = coalesce($3, unit),
           low_threshold = coalesce($4, low_threshold)
         WHERE id = $1`,
        [p.ingredient_id, p.name ?? null, p.unit ?? null, p.low_threshold ?? null],
      );
      if (res.rowCount !== 1) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
    },
  },

  'pastry.stock:receive': {
    async describe(db, p) {
      if (!Number.isInteger(p.qty) || (p.qty as number) <= 0) throw badRequest('qty: целое > 0');
      const { rows } = await db.query<{ name: string; unit: string; stock_qty: number }>(
        'SELECT name, unit, stock_qty FROM pastry.ingredients WHERE id = $1',
        [p.ingredient_id],
      );
      const i = rows[0];
      if (!i) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
      return `Приход «${clip(i.name)}»: +${p.qty} ${i.unit} (было ${i.stock_qty} → будет ${i.stock_qty + (p.qty as number)})`;
    },
    async apply(db, p, { decidedBy }) {
      return inTransaction(db, async (c) => {
        const { rows } = await c.query<{ stock_qty: number }>(
          'UPDATE pastry.ingredients SET stock_qty = stock_qty + $2 WHERE id = $1 RETURNING stock_qty',
          [p.ingredient_id, p.qty],
        );
        if (!rows[0]) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
        await c.query(
          `INSERT INTO pastry.stock_moves (ingredient_id, qty_delta, reason, note, decided_by)
           VALUES ($1, $2, 'receive', coalesce($3, ''), $4)`,
          [p.ingredient_id, p.qty, p.note ?? null, decidedBy],
        );
        return { stock_qty: rows[0].stock_qty };
      });
    },
  },

  'pastry.stock:adjust': {
    async describe(db, p) {
      if (!Number.isInteger(p.qty_delta) || p.qty_delta === 0) throw badRequest('qty_delta: ненулевое целое');
      const { rows } = await db.query<{ name: string; unit: string; stock_qty: number }>(
        'SELECT name, unit, stock_qty FROM pastry.ingredients WHERE id = $1',
        [p.ingredient_id],
      );
      const i = rows[0];
      if (!i) throw notFound(`ингредиент #${p.ingredient_id} не найден`);
      const next = i.stock_qty + (p.qty_delta as number);
      if (next < 0) throw badRequest(`остаток станет отрицательным (${i.stock_qty} + ${p.qty_delta})`);
      const sign = (p.qty_delta as number) > 0 ? '+' : '';
      return `Корректировка «${clip(i.name)}»: ${sign}${p.qty_delta} ${i.unit} (было ${i.stock_qty} → будет ${next})`;
    },
    async apply(db, p, { decidedBy }) {
      return inTransaction(db, async (c) => {
        const { rows } = await c.query<{ stock_qty: number }>(
          `UPDATE pastry.ingredients SET stock_qty = stock_qty + $2
           WHERE id = $1 AND stock_qty + $2 >= 0
           RETURNING stock_qty`,
          [p.ingredient_id, p.qty_delta],
        );
        if (!rows[0]) throw badRequest('недостаточно остатка или ингредиент не найден');
        await c.query(
          `INSERT INTO pastry.stock_moves (ingredient_id, qty_delta, reason, note, decided_by)
           VALUES ($1, $2, 'adjust', coalesce($3, ''), $4)`,
          [p.ingredient_id, p.qty_delta, p.note ?? null, decidedBy],
        );
        return { stock_qty: rows[0].stock_qty };
      });
    },
  },

  'pastry.order:create': {
    async describe(db, p) {
      checkDate(p.due_at);
      checkDate(p.ordered_at);
      checkTime(p.due_time);
      if (!Number.isInteger(p.weight_g) || (p.weight_g as number) <= 0) throw badRequest('weight_g: целое > 0');
      const [client, cake] = await Promise.all([
        db.query<{ name: string }>('SELECT name FROM pastry.clients WHERE id = $1', [p.client_id]),
        db.query<{ name: string; price_per_kg: number; active: boolean }>(
          'SELECT name, price_per_kg, active FROM pastry.cake_types WHERE id = $1',
          [p.cake_type_id],
        ),
      ]);
      if (!client.rows[0]) throw notFound(`клиент #${p.client_id} не найден`);
      const ct = cake.rows[0];
      if (!ct) throw notFound(`торт #${p.cake_type_id} не найден`);
      if (!ct.active) throw badRequest(`торт «${ct.name}» снят с продажи`);
      const price = Number(p.price_rub ?? Math.round((ct.price_per_kg * Number(p.weight_g)) / 1000));
      const prepaid = Number(p.prepaid_rub ?? 0);
      if (prepaid < 0 || price < 0) throw badRequest('цена и предоплата не могут быть отрицательными');
      if (prepaid > price) throw badRequest('предоплата больше цены');
      const kg = (Number(p.weight_g) / 1000).toFixed(2).replace(/\.?0+$/, '');
      return `Заказ: ${clip(client.rows[0].name)} — «${clip(ct.name)}» ${kg} кг, отдать ${p.due_at}${p.due_time ? ` ${p.due_time}` : ''}, ${price} ₽ (предоплата ${prepaid} ₽)`;
    },
    async apply(db, p, { decidedBy }) {
      const cake = await db.query<{ price_per_kg: number; active: boolean }>(
        'SELECT price_per_kg, active FROM pastry.cake_types WHERE id = $1',
        [p.cake_type_id],
      );
      const ct = cake.rows[0];
      if (!ct?.active) throw badRequest('торт недоступен');
      const price = p.price_rub ?? Math.round((ct.price_per_kg * (p.weight_g as number)) / 1000);
      const { rows } = await db.query<{ id: number }>(
        `INSERT INTO pastry.orders
           (client_id, cake_type_id, weight_g, ordered_at, due_at, due_time, price_rub, prepaid_rub, comment, created_by)
         VALUES ($1, $2, $3, coalesce($4::date, current_date), $5::date, coalesce($6, ''), $7, coalesce($8, 0), coalesce($9, ''), $10)
         RETURNING id`,
        [
          p.client_id,
          p.cake_type_id,
          p.weight_g,
          p.ordered_at ?? null,
          p.due_at,
          p.due_time ?? null,
          price,
          p.prepaid_rub ?? null,
          p.comment ?? null,
          decidedBy,
        ],
      );
      return { order_id: rows[0]!.id, price_rub: price };
    },
  },

  'pastry.order:update': {
    async describe(db, p) {
      const changes = (['status', 'due_at', 'due_time', 'ordered_at', 'price_rub', 'prepaid_rub', 'comment'] as const).filter(
        (k) => p[k] !== undefined,
      );
      if (!changes.length) throw badRequest('нечего менять');
      checkDate(p.due_at);
      checkDate(p.ordered_at);
      checkTime(p.due_time);
      const { rows } = await db.query<{ status: string; stock_deducted: boolean; price_rub: number; prepaid_rub: number }>(
        'SELECT status, stock_deducted, price_rub, prepaid_rub FROM pastry.orders WHERE id = $1',
        [p.order_id],
      );
      const o = rows[0];
      if (!o) throw notFound(`заказ #${p.order_id} не найден`);
      if (p.status === 'baking') throw badRequest('статус «в готовке» только через pastry.order:start_baking');
      if (o.status === 'cancelled') {
        throw badRequest('отменённый заказ менять нельзя');
      }
      // Выданный заказ: можно только зафиксировать оплату / поправить цену и комментарий.
      if (o.status === 'delivered') {
        const allowed = new Set(['prepaid_rub', 'price_rub', 'comment']);
        const bad = changes.filter((k) => !allowed.has(k));
        if (bad.length) throw badRequest(`выданный заказ: можно менять только оплату (prepaid_rub), цену и комментарий; нельзя: ${bad.join(', ')}`);
        if (p.prepaid_rub !== undefined) {
          const price = Number(p.price_rub ?? o.price_rub);
          if (Number(p.prepaid_rub) < 0 || Number(p.prepaid_rub) > price) {
            throw badRequest(`предоплата должна быть от 0 до ${price} ₽`);
          }
        }
        return `Заказ #${p.order_id} (выдан): ${changes.map((k) => `${k} → ${p[k]}`).join('; ')}`;
      }
      if (p.status === 'cancelled' && o.stock_deducted) {
        return `Заказ #${p.order_id}: отменить (ингредиенты уже списаны — на склад не вернём); ${changes.join(', ')}`;
      }
      if (p.status === 'delivered') {
        const prepaid = Number(p.prepaid_rub ?? o.prepaid_rub);
        const price = Number(p.price_rub ?? o.price_rub);
        if (prepaid < price) {
          throw badRequest(
            `нельзя выдать: долг ${price - prepaid} ₽. Сначала подтвердите оплату (prepaid_rub = ${price})`,
          );
        }
      }
      return `Заказ #${p.order_id}: ${changes.map((k) => `${k}${p[k] !== undefined ? ` → ${p[k]}` : ''}`).join('; ')}`;
    },
    async apply(db, p) {
      const cur = await db.query<{ status: string; price_rub: number; prepaid_rub: number }>(
        'SELECT status, price_rub, prepaid_rub FROM pastry.orders WHERE id = $1',
        [p.order_id],
      );
      if (!cur.rows[0]) throw notFound(`заказ #${p.order_id} не найден`);
      const status = cur.rows[0].status;
      if (status === 'cancelled') throw badRequest('отменённый заказ менять нельзя');
      if (status === 'delivered') {
        if (p.status !== undefined || p.due_at !== undefined || p.due_time !== undefined || p.ordered_at !== undefined) {
          throw badRequest('выданный заказ: нельзя менять статус и даты');
        }
        const res = await db.query(
          `UPDATE pastry.orders SET
             price_rub = coalesce($2, price_rub),
             prepaid_rub = coalesce($3, prepaid_rub),
             comment = coalesce($4, comment),
             updated_at = now()
           WHERE id = $1 AND status = 'delivered'`,
          [p.order_id, p.price_rub ?? null, p.prepaid_rub ?? null, p.comment ?? null],
        );
        if (res.rowCount !== 1) throw notFound(`заказ #${p.order_id} не найден`);
        return;
      }
      if (p.status === 'delivered') {
        const prepaid = Number(p.prepaid_rub ?? cur.rows[0].prepaid_rub);
        const price = Number(p.price_rub ?? cur.rows[0].price_rub);
        if (prepaid < price) throw badRequest(`нельзя выдать: долг ${price - prepaid} ₽ — сначала подтвердите оплату`);
      }
      const res = await db.query(
        `UPDATE pastry.orders SET
           status = coalesce($2, status),
           due_at = coalesce($3::date, due_at),
           due_time = coalesce($4, due_time),
           ordered_at = coalesce($5::date, ordered_at),
           price_rub = coalesce($6, price_rub),
           prepaid_rub = coalesce($7, prepaid_rub),
           comment = coalesce($8, comment),
           updated_at = now()
         WHERE id = $1`,
        [
          p.order_id,
          p.status ?? null,
          p.due_at ?? null,
          p.due_time ?? null,
          p.ordered_at ?? null,
          p.price_rub ?? null,
          p.prepaid_rub ?? null,
          p.comment ?? null,
        ],
      );
      if (res.rowCount !== 1) throw notFound(`заказ #${p.order_id} не найден`);
    },
  },

  'pastry.order:start_baking': {
    async describe(db, p) {
      const plan = await bakingPlan(db, p.order_id as number);
      const lines = plan.needs.map((n) => `${n.name}: нужно ${n.need} ${n.unit}, есть ${n.stock}${n.ok ? '' : ' — НЕ ХВАТАЕТ'}`);
      if (plan.short.length) {
        throw badRequest(`не хватает ингредиентов для заказа #${p.order_id}: ${plan.short.join('; ')}`);
      }
      return `Взять в готовку заказ #${p.order_id} («${clip(plan.cake)}», ${plan.kg} кг, ${clip(plan.client)}). Списать: ${lines.join('; ') || 'рецепт пуст'}`;
    },
    async apply(db, p, { decidedBy }) {
      return inTransaction(db, async (c) => {
        const plan = await bakingPlan(c, p.order_id as number);
        if (plan.short.length) throw badRequest(`не хватает: ${plan.short.join('; ')}`);
        for (const n of plan.needs) {
          const { rows } = await c.query<{ stock_qty: number }>(
            `UPDATE pastry.ingredients SET stock_qty = stock_qty - $2
             WHERE id = $1 AND stock_qty >= $2 RETURNING stock_qty`,
            [n.ingredient_id, n.need],
          );
          if (!rows[0]) throw badRequest(`не удалось списать ${n.name}`);
          await c.query(
            `INSERT INTO pastry.stock_moves (ingredient_id, qty_delta, reason, order_id, note, decided_by)
             VALUES ($1, $2, 'bake', $3, $4, $5)`,
            [n.ingredient_id, -n.need, p.order_id, `заказ #${p.order_id}`, decidedBy],
          );
        }
        const res = await c.query(
          `UPDATE pastry.orders SET status = 'baking', stock_deducted = true, updated_at = now()
           WHERE id = $1 AND stock_deducted = false AND status IN ('new', 'confirmed')`,
          [p.order_id],
        );
        if (res.rowCount !== 1) throw badRequest('заказ уже в готовке или недоступен');
        return { deducted: plan.needs.map((n) => ({ ingredient_id: n.ingredient_id, qty: n.need })) };
      });
    },
  },
};

// Что читает и под какими ролями БД пишет коннектор. Роль — одна на право записи, с минимальными грантами
// (infra/postgres/init). Пароли — в окружении этого коннектора, у гейтвея их больше нет.
export const read = {"role":"src_pastry_readonly","password_env":"PG_PASTRY_READONLY_PASSWORD"};
export const datasets: Record<string, { table: string; columns: string[] }> = {
  "clients": {
    "table": "pastry.clients",
    "columns": [
      "id",
      "name",
      "phone",
      "email",
      "notes",
      "created_at",
      "updated_at"
    ]
  },
  "ingredients": {
    "table": "pastry.ingredients",
    "columns": [
      "id",
      "name",
      "unit",
      "stock_qty",
      "low_threshold",
      "created_at"
    ]
  },
  "cake_types": {
    "table": "pastry.cake_types",
    "columns": [
      "id",
      "name",
      "price_per_kg",
      "active",
      "notes",
      "created_at"
    ]
  },
  "recipe_lines": {
    "table": "pastry.recipe_lines",
    "columns": [
      "cake_type_id",
      "ingredient_id",
      "qty_per_kg"
    ]
  },
  "orders": {
    "table": "pastry.orders",
    "columns": [
      "id",
      "client_id",
      "cake_type_id",
      "weight_g",
      "status",
      "ordered_at",
      "due_at",
      "due_time",
      "price_rub",
      "prepaid_rub",
      "comment",
      "stock_deducted",
      "created_by",
      "created_at",
      "updated_at"
    ]
  },
  "stock_moves": {
    "table": "pastry.stock_moves",
    "columns": [
      "id",
      "ingredient_id",
      "qty_delta",
      "reason",
      "order_id",
      "note",
      "decided_by",
      "created_at"
    ]
  }
};
export const roles: Record<string, { role: string; password_env: string }> = {
  "pastry.client:create": {
    "role": "src_pastry_client_create",
    "password_env": "PG_PASTRY_CLIENT_CREATE_PASSWORD"
  },
  "pastry.client:update": {
    "role": "src_pastry_client_update",
    "password_env": "PG_PASTRY_CLIENT_UPDATE_PASSWORD"
  },
  "pastry.cake_type:create": {
    "role": "src_pastry_cake_type_create",
    "password_env": "PG_PASTRY_CAKE_TYPE_CREATE_PASSWORD"
  },
  "pastry.cake_type:update": {
    "role": "src_pastry_cake_type_update",
    "password_env": "PG_PASTRY_CAKE_TYPE_UPDATE_PASSWORD"
  },
  "pastry.recipe_line:upsert": {
    "role": "src_pastry_recipe_upsert",
    "password_env": "PG_PASTRY_RECIPE_UPSERT_PASSWORD"
  },
  "pastry.recipe_line:delete": {
    "role": "src_pastry_recipe_delete",
    "password_env": "PG_PASTRY_RECIPE_DELETE_PASSWORD"
  },
  "pastry.ingredient:create": {
    "role": "src_pastry_ingredient_create",
    "password_env": "PG_PASTRY_INGREDIENT_CREATE_PASSWORD"
  },
  "pastry.ingredient:update": {
    "role": "src_pastry_ingredient_update",
    "password_env": "PG_PASTRY_INGREDIENT_UPDATE_PASSWORD"
  },
  "pastry.stock:receive": {
    "role": "src_pastry_stock_receive",
    "password_env": "PG_PASTRY_STOCK_RECEIVE_PASSWORD"
  },
  "pastry.stock:adjust": {
    "role": "src_pastry_stock_adjust",
    "password_env": "PG_PASTRY_STOCK_ADJUST_PASSWORD"
  },
  "pastry.order:create": {
    "role": "src_pastry_order_create",
    "password_env": "PG_PASTRY_ORDER_CREATE_PASSWORD"
  },
  "pastry.order:update": {
    "role": "src_pastry_order_update",
    "password_env": "PG_PASTRY_ORDER_UPDATE_PASSWORD"
  },
  "pastry.order:start_baking": {
    "role": "src_pastry_order_start_baking",
    "password_env": "PG_PASTRY_ORDER_START_BAKING_PASSWORD"
  }
};
