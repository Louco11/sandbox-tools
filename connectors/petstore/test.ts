/**
 * Проверка коннектора Petstore на тестовом HTTP API: фикстура повторяет форму Swagger Petstore (/v2),
 * настоящий petstore.swagger.io проверка не трогает.
 *   make validate-connector NAME=petstore
 */
import http from 'node:http';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';

type PetStatus = 'available' | 'pending' | 'sold';
type OrderStatus = 'placed' | 'approved' | 'delivered';

interface Pet {
  id: number;
  name: string;
  status: PetStatus;
  category?: { id?: number; name?: string };
  photoUrls: string[];
  tags: { id?: number; name?: string }[];
}

interface Order {
  id: number;
  petId: number;
  quantity: number;
  status: OrderStatus;
  complete: boolean;
}

interface Store {
  pets: Pet[];
  orders: Order[];
  inventory: Record<string, number>;
}

const others = <T extends { id: number }>(rows: T[], id: number) => JSON.stringify(rows.filter((r) => r.id !== id));
const nextId = (rows: { id: number }[]) => rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;

function rebuildInventory(pets: Pet[]): Record<string, number> {
  const inv: Record<string, number> = { available: 0, pending: 0, sold: 0 };
  for (const p of pets) inv[p.status] = (inv[p.status] ?? 0) + 1;
  return inv;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  let raw = '';
  for await (const c of req) raw += c;
  return raw;
}

export default defineConnectorTest({
  // Боевой стенд ходит на публичный sample Petstore; проверка — только на локальной фикстуре.
  hosts: ['petstore.swagger.io'],
  async start() {
    let pets: Pet[] = [
      { id: 1, name: 'Doggie', status: 'available', category: { id: 1, name: 'Dogs' }, photoUrls: ['https://example.com/doggie.jpg'], tags: [{ id: 1, name: 'friendly' }] },
      { id: 2, name: 'Kitty', status: 'pending', category: { id: 2, name: 'Cats' }, photoUrls: [], tags: [] },
      { id: 3, name: 'Fishy', status: 'sold', category: { id: 3, name: 'Fish' }, photoUrls: [], tags: [{ id: 2, name: 'quiet' }] },
    ];
    let orders: Order[] = [
      { id: 1, petId: 1, quantity: 1, status: 'placed', complete: false },
      { id: 2, petId: 3, quantity: 2, status: 'approved', complete: false },
    ];
    let inventory = rebuildInventory(pets);

    const snapshot = (): Store => structuredClone({ pets, orders, inventory });

    const server = http.createServer(async (req, res) => {
      const send = (status: number, body?: unknown) => {
        if (body === undefined) return void res.writeHead(status).end();
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      };
      if (req.headers.api_key !== 'test-token') return send(401, { error: 'unauthorized' });

      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;

      if (req.method === 'GET' && path === '/pet/findByStatus') {
        const status = url.searchParams.get('status') ?? 'available';
        return send(200, pets.filter((p) => p.status === status));
      }

      const petMatch = path.match(/^\/pet\/(\d+)$/);
      if (petMatch) {
        const id = Number(petMatch[1]);
        const pet = pets.find((p) => p.id === id);
        if (req.method === 'GET') return pet ? send(200, pet) : send(404, { message: 'Pet not found' });
        if (req.method === 'DELETE') {
          if (!pet) return send(404, { message: 'Pet not found' });
          pets = pets.filter((p) => p.id !== id);
          inventory = rebuildInventory(pets);
          return send(200);
        }
        if (req.method === 'POST') {
          if (!pet) return send(404, { message: 'Pet not found' });
          const form = new URLSearchParams(await readBody(req));
          const name = form.get('name');
          const status = form.get('status') as PetStatus | null;
          pets = pets.map((p) => (p.id === id ? {
            ...p,
            ...(name ? { name } : {}),
            ...(status ? { status } : {}),
          } : p));
          inventory = rebuildInventory(pets);
          return send(200);
        }
      }

      if (req.method === 'POST' && path === '/pet') {
        const body = JSON.parse(await readBody(req)) as Pet;
        const row: Pet = {
          id: body.id ?? nextId(pets),
          name: body.name,
          status: body.status ?? 'available',
          category: body.category,
          photoUrls: body.photoUrls ?? [],
          tags: body.tags ?? [],
        };
        pets = [...pets, row];
        inventory = rebuildInventory(pets);
        return send(200, row);
      }

      if (req.method === 'GET' && path === '/store/inventory') return send(200, inventory);

      if (req.method === 'POST' && path === '/store/order') {
        const body = JSON.parse(await readBody(req)) as Order;
        const row: Order = {
          id: body.id ?? nextId(orders),
          petId: body.petId,
          quantity: body.quantity,
          status: body.status ?? 'placed',
          complete: body.complete ?? false,
        };
        orders = [...orders, row];
        return send(200, row);
      }

      const orderMatch = path.match(/^\/store\/order\/(\d+)$/);
      if (orderMatch) {
        const id = Number(orderMatch[1]);
        const order = orders.find((o) => o.id === id);
        if (req.method === 'GET') return order ? send(200, order) : send(404, { message: 'Order not found' });
        if (req.method === 'DELETE') {
          if (!order) return send(404, { message: 'Order not found' });
          orders = orders.filter((o) => o.id !== id);
          return send(200);
        }
      }

      return send(404, { message: 'not found' });
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return {
      env: { API_URL: `http://127.0.0.1:${port}`, API_TOKEN: 'test-token' },
      snapshot: async () => snapshot(),
      stop: async () => void server.close(),
    };
  },
  variants: [{
    source: 'petstore-readonly',
    scenarios: [
      {
        write: 'petstore.pet:add',
        params: { name: 'Hamster', status: 'available', category_name: 'Rodents' },
        expect: (b: Store, a: Store) => {
          if (a.pets.length !== b.pets.length + 1) return 'питомец не добавлен';
          if (a.pets.at(-1)!.name !== 'Hamster') return 'добавлен не тот питомец';
          if (JSON.stringify(a.orders) !== JSON.stringify(b.orders)) return 'изменились заказы';
        },
      },
      {
        write: 'petstore.pet:update_status',
        params: { pet_id: 1, status: 'sold' },
        expect: (b: Store, a: Store) => {
          if (a.pets.find((p) => p.id === 1)?.status !== 'sold') return 'статус не изменился';
          if (others(a.pets, 1) !== others(b.pets, 1)) return 'изменились другие питомцы';
          if (JSON.stringify(a.orders) !== JSON.stringify(b.orders)) return 'изменились заказы';
        },
      },
      {
        write: 'petstore.pet:delete',
        params: { pet_id: 2 },
        expect: (b: Store, a: Store) => {
          if (a.pets.some((p) => p.id === 2)) return 'питомец не удалён';
          if (a.pets.length !== b.pets.length - 1) return 'удалилось больше одного питомца';
          if (JSON.stringify(a.orders) !== JSON.stringify(b.orders)) return 'изменились заказы';
        },
      },
      {
        write: 'petstore.order:place',
        params: { pet_id: 1, quantity: 3, status: 'placed' },
        expect: (b: Store, a: Store) => {
          if (a.orders.length !== b.orders.length + 1) return 'заказ не создан';
          const last = a.orders.at(-1)!;
          if (last.petId !== 1 || last.quantity !== 3) return 'создан не тот заказ';
          if (JSON.stringify(a.pets) !== JSON.stringify(b.pets)) return 'изменились питомцы';
        },
      },
      {
        write: 'petstore.order:delete',
        params: { order_id: 1 },
        expect: (b: Store, a: Store) => {
          if (a.orders.some((o) => o.id === 1)) return 'заказ не удалён';
          if (a.orders.length !== b.orders.length - 1) return 'удалилось больше одного заказа';
          if (JSON.stringify(a.pets) !== JSON.stringify(b.pets)) return 'изменились питомцы';
        },
      },
    ],
  }],
});
