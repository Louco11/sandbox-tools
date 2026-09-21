/**
 * Коннектор «Поставщики» — демо второго источника, подключённого без единой строки в гейтвее.
 * В компании такой сервис держит команда закупок; здесь данные — JSON-файл в томе коннектора.
 *
 * Наборы: suppliers (поставщики), offers (что и почём поставляют).
 * Записи: suppliers.supplier:create, suppliers.offer:set_price, suppliers.supplier:archive (важное — confirm в реестре).
 * Сеть: только sources (гейтвей). Тулы и CI до коннектора не достают.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectorError, applyQuery, startConnector, type Row } from '../../packages/connector/src/index.ts';

const DATA_DIR = process.env.DATA_DIR ?? '/data';
const FILE = join(DATA_DIR, 'suppliers.json');

interface Supplier { id: number; name: string; city: string; contact: string; phone: string; archived: boolean; created_by: string }
interface Offer { id: number; supplier_id: number; item: string; unit: string; price: number; updated_at: string; updated_by: string }
interface Store { suppliers: Supplier[]; offers: Offer[] }

const SEED: Store = {
  suppliers: [
    { id: 1, name: 'Молочная ферма «Заречье»', city: 'Тверь', contact: 'Ольга Сомова', phone: '+7 900 111-22-33', archived: false, created_by: 'seed' },
    { id: 2, name: 'Шоколадный дом', city: 'Москва', contact: 'Игорь Лаптев', phone: '+7 900 222-33-44', archived: false, created_by: 'seed' },
    { id: 3, name: 'Упаковка-Про', city: 'Подольск', contact: 'Мария Ким', phone: '+7 900 333-44-55', archived: false, created_by: 'seed' },
  ],
  offers: [
    { id: 1, supplier_id: 1, item: 'Сливки 33%', unit: 'л', price: 420, updated_at: '2026-09-01', updated_by: 'seed' },
    { id: 2, supplier_id: 1, item: 'Масло сливочное 82%', unit: 'кг', price: 980, updated_at: '2026-09-01', updated_by: 'seed' },
    { id: 3, supplier_id: 2, item: 'Какао-порошок', unit: 'кг', price: 1350, updated_at: '2026-09-05', updated_by: 'seed' },
    { id: 4, supplier_id: 2, item: 'Шоколад тёмный 70%', unit: 'кг', price: 1890, updated_at: '2026-09-05', updated_by: 'seed' },
    { id: 5, supplier_id: 3, item: 'Коробка для торта большая', unit: 'шт', price: 95, updated_at: '2026-09-10', updated_by: 'seed' },
  ],
};

function load(): Store {
  if (!existsSync(FILE)) {
    mkdirSync(DATA_DIR, { recursive: true });
    save(SEED);
  }
  return JSON.parse(readFileSync(FILE, 'utf8')) as Store;
}
function save(s: Store): void {
  writeFileSync(`${FILE}.tmp`, JSON.stringify(s, null, 2));
  renameSync(`${FILE}.tmp`, FILE); // атомарно: оборванная запись не портит файл
}

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
const today = () => new Date().toISOString().slice(0, 10);
const nextId = (rows: { id: number }[]) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

function supplier(s: Store, id: unknown): Supplier {
  const found = s.suppliers.find((x) => x.id === id);
  if (!found) throw new ConnectorError(404, `поставщика #${id} нет`);
  return found;
}
function offer(s: Store, id: unknown): Offer {
  const found = s.offers.find((x) => x.id === id);
  if (!found) throw new ConnectorError(404, `предложения #${id} нет`);
  return found;
}

startConnector({
  name: 'suppliers',
  token: process.env.CONNECTOR_TOKEN ?? '',
  datasets: {
    suppliers: (q) => applyQuery(load().suppliers as unknown as Row[], q),
    // active — вычисляется: предложения поставщика из архива недоступны для заказа.
    offers: (q) => {
      const s = load();
      const archived = new Set(s.suppliers.filter((x) => x.archived).map((x) => x.id));
      return applyQuery(s.offers.map((o) => ({ ...o, active: !archived.has(o.supplier_id) })), q);
    },
  },
  writes: {
    'suppliers.supplier:create': {
      describe: (p) => {
        const s = load();
        if (s.suppliers.some((x) => x.name.toLowerCase() === String(p.name).toLowerCase())) {
          throw new ConnectorError(409, `поставщик «${p.name}» уже есть`);
        }
        return `Добавить поставщика «${p.name}» (${p.city})${p.contact ? `, контакт — ${p.contact}` : ''}`;
      },
      apply: (p, by) => {
        const s = load();
        const row: Supplier = {
          id: nextId(s.suppliers), name: String(p.name), city: String(p.city), contact: String(p.contact ?? ''),
          phone: String(p.phone ?? ''), archived: false, created_by: by.decided_by,
        };
        s.suppliers.push(row);
        save(s);
        return { supplier_id: row.id };
      },
    },
    'suppliers.offer:set_price': {
      describe: (p) => {
        const s = load();
        const o = offer(s, p.offer_id);
        const sup = supplier(s, o.supplier_id);
        if (sup.archived) throw new ConnectorError(409, `поставщик «${sup.name}» в архиве — цены не меняются`);
        if (Number(p.price) <= 0) throw new ConnectorError(400, 'цена должна быть больше нуля');
        return `Цена «${o.item}» у «${sup.name}»: ${rub(o.price)} → ${rub(Number(p.price))} за ${o.unit}`;
      },
      apply: (p, by) => {
        const s = load();
        const o = offer(s, p.offer_id);
        o.price = Number(p.price);
        o.updated_at = today();
        o.updated_by = by.decided_by;
        save(s);
        return { offer_id: o.id, price: o.price };
      },
    },
    'suppliers.supplier:archive': {
      describe: (p) => {
        const s = load();
        const sup = supplier(s, p.supplier_id);
        if (sup.archived) throw new ConnectorError(409, `поставщик «${sup.name}» уже в архиве`);
        const n = s.offers.filter((o) => o.supplier_id === sup.id).length;
        return `Перенести в архив поставщика «${sup.name}»: его ${n} предложений перестанут быть доступны для заказа`;
      },
      apply: (p) => {
        const s = load();
        supplier(s, p.supplier_id).archived = true;
        save(s);
        return { supplier_id: p.supplier_id, archived: true };
      },
    },
  },
});
