/** Проверка MCP-коннектора «__TITLE__» на тестовом MCP-сервере (fixture/) с данными во временном файле. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';

type Item = { id: number; status: string };

export default defineConnectorTest({
  hosts: [],
  async start() {
    const dir = mkdtempSync(join(tmpdir(), '__NAME__-test-'));
    const file = join(dir, 'fixture.json');
    return {
      env: { FIXTURE_DATA_FILE: file },
      snapshot: async () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
      stop: async () => rmSync(dir, { recursive: true, force: true }),
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
