/**
 * Проверка коннектора «__TITLE__» на тестовом API: фикстура — HTTP-сервер прямо в процессе проверки, с демо-данными.
 * Настоящую систему проверка не трогает. TODO агенту: фикстура повторяет ответы вашего API (форма, коды ошибок).
 */
import http from 'node:http';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';

type Item = { id: number; name: string; status: string };

export default defineConnectorTest({
  hosts: [],
  async start() {
    let items: Item[] = [
      { id: 1, name: 'Первая позиция', status: 'active' },
      { id: 2, name: 'Вторая позиция', status: 'active' },
      { id: 3, name: 'Третья позиция', status: 'archived' },
    ];
    const server = http.createServer(async (req, res) => {
      const send = (status: number, body: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
      if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: 'unauthorized' });
      const m = req.url?.match(/^\/items(?:\/(\d+))?$/);
      if (!m) return send(404, {});
      if (!m[1]) return send(200, { items });
      const item = items.find((i) => i.id === Number(m[1]));
      if (!item) return send(404, {});
      if (req.method === 'PATCH') {
        let raw = '';
        for await (const c of req) raw += c;
        items = items.map((i) => (i.id === item.id ? { ...i, status: JSON.parse(raw).status } : i));
        return send(200, items.find((i) => i.id === item.id));
      }
      return send(200, item);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    return {
      env: { API_URL: `http://127.0.0.1:${port}`, API_TOKEN: 'test-token' },
      snapshot: async () => structuredClone(items),
      stop: async () => void server.close(),
    };
  },
  variants: [{
    source: '__SOURCE__',
    scenarios: [{
      write: '__PREFIX__.item:set_status',
      params: { item_id: 1, status: 'archived' },
      expect: (b: Item[], a: Item[]) => {
        if (a.find((i) => i.id === 1)?.status !== 'archived') return 'статус не изменился';
        if (JSON.stringify(a.filter((i) => i.id !== 1)) !== JSON.stringify(b.filter((i) => i.id !== 1))) return 'изменились другие позиции';
      },
    }],
  }],
});
