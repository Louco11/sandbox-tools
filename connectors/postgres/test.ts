/**
 * Проверка коннектора источников postgres на тестовой базе: временный Postgres в Docker из тех же init-скриптов
 * стенда (схема, роли с минимальными грантами, демо-данные), пароли — тестовые. Боевую базу проверка не трогает.
 *   make validate-connector NAME=postgres
 *
 * Сценарий говорит, какие таблицы и как должны измениться (changes); изменение любой другой — провал.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';
import { changes, pgTestSystem } from '../../packages/connector/src/testkit-pg.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PASSWORDS = [...new Set(readFileSync(join(ROOT, 'infra/init-env.sh'), 'utf8').match(/PG_[A-Z_]+_PASSWORD/g) ?? [])];
const testPasswords = Object.fromEntries(PASSWORDS.map((p) => [p, 'test']));

export default defineConnectorTest({
  hosts: ['postgres'],
  async start() {
    const pg = await pgTestSystem({
      initDir: join(ROOT, 'infra/postgres/init'),
      schemas: ['tasks', 'knowledge', 'boards', 'pastry'],
      database: 'sources',
      env: testPasswords,
    });
    return { ...pg, env: { ...pg.env, ...testPasswords } };
  },
  variants: [
    {
      source: 'tasks-readonly',
      env: { SOURCE: 'tasks' },
      scenarios: [
        { write: 'tasks.task:create', params: { title: 'Тестовая задача', priority: 'normal', assignee: 'Анна Смирнова' }, expect: changes({ 'tasks.tasks': 1 }) },
        { write: 'tasks.task:update', params: { task_id: 1, priority: 'urgent', status: 'in_progress' }, expect: changes({ 'tasks.tasks': 0 }) },
      ],
    },
    {
      source: 'knowledge-readonly',
      env: { SOURCE: 'knowledge' },
      scenarios: [
        { write: 'knowledge.note:create', params: { kind: 'note', title: 'Тестовая заметка', body: 'Проверка коннектора', tags: 'тест' }, expect: changes({ 'knowledge.notes': 1 }) },
      ],
    },
    {
      source: 'boards-readonly',
      env: { SOURCE: 'boards' },
      scenarios: [
        { write: 'boards.board:create', params: { name: 'Тестовая доска', content: '{"els":[{"id":"a","type":"sticky","text":"1"}]}' }, expect: changes({ 'boards.boards': 1, 'boards.versions': 1 }) },
        { write: 'boards.board:save', params: { board_id: 1, base_version: 1, content: '{"els":[]}', note: 'очистить' }, expect: changes({ 'boards.boards': 0, 'boards.versions': 1 }) },
      ],
    },
    {
      source: 'pastry-readonly',
      env: { SOURCE: 'pastry' },
      scenarios: [
        { write: 'pastry.client:create', params: { name: 'Тестовый клиент', phone: '+7 900 000-00-00' }, expect: changes({ 'pastry.clients': 1 }) },
        { write: 'pastry.client:update', params: { client_id: 1, notes: 'тест' }, expect: changes({ 'pastry.clients': 0 }) },
        { write: 'pastry.cake_type:create', params: { name: 'Тестовый торт', price_per_kg: 1500 }, expect: changes({ 'pastry.cake_types': 1 }) },
        { write: 'pastry.cake_type:update', params: { cake_type_id: 1, price_per_kg: 1234 }, expect: changes({ 'pastry.cake_types': 0 }) },
        { write: 'pastry.ingredient:create', params: { name: 'Тестовый продукт', unit: 'g' }, expect: changes({ 'pastry.ingredients': 1 }) },
        { write: 'pastry.ingredient:update', params: { ingredient_id: 1, low_threshold: 1500 }, expect: changes({ 'pastry.ingredients': 0 }) },
        { write: 'pastry.stock:receive', params: { ingredient_id: 1, qty: 100 }, expect: changes({ 'pastry.ingredients': 0, 'pastry.stock_moves': 1 }) },
        { write: 'pastry.stock:adjust', params: { ingredient_id: 1, qty_delta: -50, note: 'тест' }, expect: changes({ 'pastry.ingredients': 0, 'pastry.stock_moves': 1 }) },
        { write: 'pastry.order:create', params: { client_id: 1, cake_type_id: 1, weight_g: 1000, due_at: '2030-01-01' }, expect: changes({ 'pastry.orders': 1 }) },
        { write: 'pastry.order:update', params: { order_id: 3, comment: 'тест' }, expect: changes({ 'pastry.orders': 0 }) },
        // Заказ №1 — медовик, в рецепте 5 ингредиентов (сид): 5 движений склада.
        { write: 'pastry.order:start_baking', params: { order_id: 1 }, expect: changes({ 'pastry.orders': 0, 'pastry.ingredients': 0, 'pastry.stock_moves': 5 }) },
        { write: 'pastry.recipe_line:upsert', params: { cake_type_id: 1, ingredient_id: 1, qty_per_kg: 300 }, expect: changes({ 'pastry.recipe_lines': 0 }) },
        { write: 'pastry.recipe_line:delete', params: { cake_type_id: 1, ingredient_id: 1 }, expect: changes({ 'pastry.recipe_lines': -1 }) },
      ],
    },
  ],
});
