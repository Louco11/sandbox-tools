/**
 * Коннектор к Swagger Petstore (OpenAPI 2.0, basePath /v2).
 * Адрес и api_key — только из окружения (API_URL, API_TOKEN): в коде их нет, боевую учётку ставит человек.
 *
 * Наборы: pets (питомцы), inventory (остатки по статусу).
 * Записи: добавить/сменить статус/удалить питомца; оформить/удалить заказ.
 * Не пробрасываем всё API: без users (пароли), без uploadImage и устаревшего findByTags.
 */
import { ConnectorError, applyQuery, startConnector, type Row } from '../../packages/connector/src/index.ts';

const API = process.env.API_URL ?? '';
const TOKEN = process.env.API_TOKEN ?? '';

type PetStatus = 'available' | 'pending' | 'sold';
type OrderStatus = 'placed' | 'approved' | 'delivered';

interface PetApi {
  id?: number;
  name: string;
  status?: PetStatus;
  category?: { id?: number; name?: string };
  photoUrls?: string[];
  tags?: { id?: number; name?: string }[];
}

interface OrderApi {
  id?: number;
  petId?: number;
  quantity?: number;
  shipDate?: string;
  status?: OrderStatus;
  complete?: boolean;
}

/** Плоская строка набора pets — вложенные category/tags/photoUrls из API не отдаём как объекты. */
function petRow(p: PetApi): Row {
  return {
    id: p.id ?? 0,
    name: p.name,
    status: p.status ?? 'available',
    category_id: p.category?.id ?? null,
    category_name: p.category?.name ?? null,
    photo_urls: (p.photoUrls ?? []).join(', '),
    tags: (p.tags ?? []).map((t) => t.name).filter(Boolean).join(', '),
  };
}

async function api<T>(path: string, init?: { method?: string; body?: unknown; form?: Record<string, string> }): Promise<T> {
  const headers: Record<string, string> = { api_key: TOKEN };
  let body: string | undefined;
  if (init?.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(init.form).toString();
  } else if (init?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const r = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) throw new ConnectorError(404, `в Petstore нет ${path}`);
  if (r.status >= 400 && r.status < 500) {
    const text = (await r.text()).trim() || r.statusText;
    throw new ConnectorError(400, text);
  }
  if (!r.ok) throw new Error(`Petstore ${path}: ${r.status}`);
  const text = await r.text();
  if (!text) return {} as T;
  return JSON.parse(text) as T;
}

async function getPet(id: unknown): Promise<PetApi> {
  return api<PetApi>(`/pet/${Number(id)}`);
}

async function listPets(): Promise<PetApi[]> {
  const statuses: PetStatus[] = ['available', 'pending', 'sold'];
  const byId = new Map<number, PetApi>();
  for (const status of statuses) {
    const rows = await api<PetApi[]>(`/pet/findByStatus?status=${status}`);
    for (const p of rows) {
      if (p.id != null) byId.set(p.id, p);
    }
  }
  return [...byId.values()];
}

startConnector({
  name: 'petstore',
  token: process.env.CONNECTOR_TOKEN ?? '',
  datasets: {
    pets: async (q) => applyQuery((await listPets()).map(petRow), q),
    inventory: async (q) => {
      const map = await api<Record<string, number>>('/store/inventory');
      const rows = Object.entries(map).map(([status, quantity]) => ({ status, quantity }));
      return applyQuery(rows as unknown as Row[], q);
    },
  },
  writes: {
    'petstore.pet:add': {
      describe: (p) => {
        const status = String(p.status ?? 'available');
        return `Добавить питомца «${p.name}» со статусом ${status}`;
      },
      apply: async (p) => {
        const body: PetApi = {
          name: String(p.name),
          photoUrls: p.photo_url ? [String(p.photo_url)] : [],
          status: String(p.status ?? 'available') as PetStatus,
          ...(p.category_name ? { category: { name: String(p.category_name) } } : {}),
        };
        const created = await api<PetApi>('/pet', { method: 'POST', body });
        return { pet_id: created.id ?? null, name: created.name, status: created.status ?? body.status };
      },
    },
    'petstore.pet:update_status': {
      describe: async (p) => {
        const cur = await getPet(p.pet_id);
        if (cur.status === p.status) throw new ConnectorError(409, `у «${cur.name}» уже статус ${p.status}`);
        return `Питомец «${cur.name}» (#${cur.id}): статус ${cur.status} → ${p.status}`;
      },
      apply: async (p) => {
        await api(`/pet/${Number(p.pet_id)}`, {
          method: 'POST',
          form: { status: String(p.status), ...(p.name ? { name: String(p.name) } : {}) },
        });
        return { pet_id: Number(p.pet_id), status: String(p.status) };
      },
    },
    'petstore.pet:delete': {
      describe: async (p) => {
        const cur = await getPet(p.pet_id);
        return `Удалить питомца «${cur.name}» (#${cur.id}, статус ${cur.status})`;
      },
      apply: async (p) => {
        await api(`/pet/${Number(p.pet_id)}`, { method: 'DELETE' });
        return { pet_id: Number(p.pet_id), deleted: true };
      },
    },
    'petstore.order:place': {
      describe: (p) =>
        `Оформить заказ: питомец #${p.pet_id}, количество ${p.quantity}, статус ${p.status ?? 'placed'}`,
      apply: async (p) => {
        const body: OrderApi = {
          petId: Number(p.pet_id),
          quantity: Number(p.quantity),
          status: String(p.status ?? 'placed') as OrderStatus,
          complete: false,
        };
        const order = await api<OrderApi>('/store/order', { method: 'POST', body });
        return { order_id: order.id ?? null, pet_id: order.petId ?? body.petId, quantity: order.quantity ?? body.quantity };
      },
    },
    'petstore.order:delete': {
      describe: async (p) => {
        const order = await api<OrderApi>(`/store/order/${Number(p.order_id)}`);
        return `Удалить заказ #${order.id}: питомец #${order.petId}, ${order.quantity} шт., статус ${order.status}`;
      },
      apply: async (p) => {
        await api(`/store/order/${Number(p.order_id)}`, { method: 'DELETE' });
        return { order_id: Number(p.order_id), deleted: true };
      },
    },
  },
});
