/** Проверка MCP-коннектора Holst на фикстуре (fixture/) с данными во временном файле. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConnectorTest } from '../../packages/connector/src/testkit.ts';

interface Store {
  workspaces: { id: string; name: string }[];
  boards: { id: string; name: string }[];
  runs: { board_id: string; description: string }[];
}

export default defineConnectorTest({
  hosts: ['127.0.0.1'],
  async start() {
    const dir = mkdtempSync(join(tmpdir(), 'holst-test-'));
    const file = join(dir, 'holst.json');
    return {
      env: { FIXTURE_DATA_FILE: file },
      snapshot: async () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Store : null),
      stop: async () => rmSync(dir, { recursive: true, force: true }),
    };
  },
  variants: [{
    source: 'holst-readonly',
    scenarios: [
      {
        write: 'holst.board:create',
        params: { name: 'Песочница', workspace_id: 'ws-team' },
        expect: (b: Store, a: Store) => {
          if (a.boards.length !== b.boards.length + 1) return 'доска не создана';
          if (a.boards.at(-1)!.name !== 'Песочница') return 'создана не та доска';
          if (JSON.stringify(a.workspaces) !== JSON.stringify(b.workspaces)) return 'изменились пространства';
          if (JSON.stringify(a.runs) !== JSON.stringify(b.runs)) return 'изменились запуски';
        },
      },
      {
        write: 'holst.board:run',
        params: {
          board_id: 'b3e7d953-c1d5-4e6b-874d-07d0b9d56fc1',
          code: 'holst.ping()',
          description: 'проверка связи',
        },
        expect: (b: Store, a: Store) => {
          if (a.runs.length !== b.runs.length + 1) return 'запуск не записан';
          if (a.runs.at(-1)!.description !== 'проверка связи') return 'не то описание';
          if (JSON.stringify(a.boards) !== JSON.stringify(b.boards)) return 'изменились доски';
          if (JSON.stringify(a.workspaces) !== JSON.stringify(b.workspaces)) return 'изменились пространства';
        },
      },
    ],
  }],
});
