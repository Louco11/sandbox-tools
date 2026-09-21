/**
 * Проверка коннектора «Поставщики» на тестовых данных: временный каталог, коннектор сам кладёт туда демо-данные.
 *   make validate-connector NAME=suppliers
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';

interface Store { suppliers: { id: number; name: string; archived: boolean }[]; offers: { id: number; price: number }[] }

const others = <T extends { id: number }>(rows: T[], id: number) => JSON.stringify(rows.filter((r) => r.id !== id));

export default defineConnectorTest({
  hosts: [],
  async start() {
    const dir = mkdtempSync(join(tmpdir(), 'suppliers-test-'));
    const file = join(dir, 'suppliers.json');
    return {
      env: { DATA_DIR: dir },
      snapshot: async () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
      stop: async () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  variants: [{
    source: 'suppliers-readonly',
    scenarios: [
      {
        write: 'suppliers.supplier:create',
        params: { name: 'Тестовый поставщик', city: 'Тула' },
        expect: (b: Store, a: Store) => {
          if (a.suppliers.length !== b.suppliers.length + 1) return 'поставщик не добавлен';
          if (a.suppliers.at(-1)!.name !== 'Тестовый поставщик') return 'добавлен не тот поставщик';
          if (JSON.stringify(a.offers) !== JSON.stringify(b.offers)) return 'изменились предложения — этого не обещали';
        },
      },
      {
        write: 'suppliers.offer:set_price',
        params: { offer_id: 1, price: 555 },
        expect: (b: Store, a: Store) => {
          if (a.offers.find((o) => o.id === 1)?.price !== 555) return 'цена не изменилась';
          if (others(a.offers, 1) !== others(b.offers, 1)) return 'изменились другие предложения';
          if (JSON.stringify(a.suppliers) !== JSON.stringify(b.suppliers)) return 'изменились поставщики';
        },
      },
      {
        write: 'suppliers.supplier:archive',
        params: { supplier_id: 2 },
        expect: (b: Store, a: Store) => {
          if (!a.suppliers.find((s) => s.id === 2)?.archived) return 'поставщик не в архиве';
          if (others(a.suppliers, 2) !== others(b.suppliers, 2)) return 'изменились другие поставщики';
          if (JSON.stringify(a.offers) !== JSON.stringify(b.offers)) return 'изменились предложения';
        },
      },
    ],
  }],
});
