/** Проверка MCP-коннектора CRM на тестовом MCP-сервере (fixture/) с данными во временном файле. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';

type Deal = { id: number; stage: string };

export default defineConnectorTest({
  hosts: [],
  async start() {
    const dir = mkdtempSync(join(tmpdir(), 'crm-test-'));
    const file = join(dir, 'crm.json');
    return {
      env: { CRM_DATA_FILE: file },
      snapshot: async () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null),
      stop: async () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  variants: [{
    source: 'crm-demo-readonly',
    scenarios: [{
      write: 'crm.deal:set_stage',
      params: { deal_id: 2, stage: 'negotiation' },
      expect: (b: Deal[], a: Deal[]) => {
        if (a.find((d) => d.id === 2)?.stage !== 'negotiation') return 'стадия не изменилась';
        if (JSON.stringify(a.filter((d) => d.id !== 2)) !== JSON.stringify(b.filter((d) => d.id !== 2))) return 'изменились другие сделки';
      },
    }],
  }],
});
