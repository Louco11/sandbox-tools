/**
 * Коннектор «__TITLE__» к HTTP API системы.
 * Адрес и учётка — только из окружения (API_URL, API_TOKEN): в коде их нет, боевую учётку ставит человек.
 * Учётка — с минимумом прав: чтение + ровно одобренные в реестре записи.
 *
 * TODO агенту: заменить демо-набор items и запись __PREFIX__.item:set_status на наборы и записи своей системы;
 * то же — в registry.draft.yaml и test.ts. Проверка: make validate-connector NAME=__NAME__
 */
import { ConnectorError, applyQuery, startConnector, type Row } from '../../packages/connector/src/index.ts';

const API = process.env.API_URL ?? '';
const TOKEN = process.env.API_TOKEN ?? '';

async function api<T>(path: string, init?: { method: string; body: unknown }): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: init ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  // Ошибки системы, понятные человеку, — ConnectorError; остальное гейтвей покажет как «источник недоступен».
  if (r.status === 404) throw new ConnectorError(404, `в системе нет ${path}`);
  if (r.status === 409) throw new ConnectorError(409, await r.text());
  if (r.status >= 400 && r.status < 500) throw new ConnectorError(400, await r.text());
  if (!r.ok) throw new Error(`API ${path}: ${r.status}`);
  return (await r.json()) as T;
}

interface Item { id: number; name: string; status: string }

startConnector({
  name: '__NAME__',
  token: process.env.CONNECTOR_TOKEN ?? '',
  datasets: {
    // Что API умеет фильтровать само — передавайте в параметры запроса; остальное досчитает applyQuery.
    items: async (q) => applyQuery((await api<{ items: Item[] }>('/items')).items as unknown as Row[], q),
  },
  writes: {
    '__PREFIX__.item:set_status': {
      // describe только читает: человеку — что изменится, с текущим состоянием.
      describe: async (p) => {
        const cur = await api<Item>(`/items/${p.item_id}`);
        if (cur.status === p.status) throw new ConnectorError(409, `у «${cur.name}» уже статус ${p.status}`);
        return `Позиция «${cur.name}»: статус ${cur.status} → ${p.status}`;
      },
      apply: async (p) => api<Row>(`/items/${p.item_id}`, { method: 'PATCH', body: { status: p.status } }),
    },
  },
});
