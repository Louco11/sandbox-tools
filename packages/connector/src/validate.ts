/**
 * Проверка контракта коннектора на тестовой системе — то, что делает validate_connector (mcp-sandbox).
 *   node packages/connector/src/validate.ts <имя>      (make validate-connector NAME=<имя>)
 *
 * Код: нет секретов, нет чужих адресов, нет запуска процессов.
 * Контракт (коннектор запущен против тестовой системы, говорим с ним как гейтвей):
 *   без токена — отказ; состав совпадает с реестром (нет записей вне реестра и недостающих);
 *   наборы отдают ровно поля реестра; describe ничего не меняет; apply делает то, что ожидает сценарий.
 * Источник берётся из registry/sources.yaml, а если его там ещё нет — из черновика connectors/<имя>/registry.draft.yaml
 * (черновик — предложение агента, одобряет человек).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { loadRegistry, registrySchema, type Registry } from '../../manifest/src/index.ts';
import type { ConnectorTest } from './testkit.ts';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');

export interface Check { ok: boolean | 'warn'; text: string }

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|js|mjs|yaml|yml|json)$/.test(e.name) && !e.parentPath.includes('node_modules'))
    .map((e) => join(e.parentPath, e.name));
}

/** Реестр + черновик коннектора (источники, которых в реестре ещё нет). */
function registryWithDraft(dir: string): { registry: Registry; draft: Set<string> } {
  const main = loadRegistry(join(ROOT, 'registry', 'sources.yaml'));
  const draftPath = join(dir, 'registry.draft.yaml');
  if (!existsSync(draftPath)) return { registry: main, draft: new Set() };
  const d = parse(readFileSync(draftPath, 'utf8')) as { sources?: object; writes?: object };
  const parsed = registrySchema.safeParse({ version: 1, policy: main.policy, sources: d.sources ?? {}, writes: d.writes ?? {} });
  if (!parsed.success) throw new Error(`черновик реестра ${relative(ROOT, draftPath)} невалиден: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const draft = new Set(Object.keys(parsed.data.sources).filter((s) => !main.sources[s]));
  return {
    registry: {
      ...main,
      sources: { ...parsed.data.sources, ...main.sources },
      writes: { ...parsed.data.writes, ...main.writes },
    },
    draft,
  };
}

function staticChecks(dir: string, hosts: string[]): Check[] {
  const out: Check[] = [];
  // Секрет — длинная строка без пробелов рядом со словом password/secret/token/key (в том числе значение
  // по умолчанию: process.env.X ?? '…'), известные форматы ключей и приватные ключи.
  // Кандидат похож на ключ, если в нём есть и цифры, и строчные буквы: так отсекаются имена переменных окружения
  // (PG_…_PASSWORD) и обычные строки (application/json).
  const keyLike = (v: string) => /\d/.test(v) && /[a-z]/.test(v);
  const nearKeyword = (text: string) => [...text.matchAll(/(password|passwd|secret|token|api[_-]?key)[^\n]{0,60}?['"]([A-Za-z0-9_\-+/=.]{12,})['"]/gi)]
    .some((m) => keyLike(m[2]!));
  const secret = [
    { test: nearKeyword },
    /\b(sk_live_|sk_test_|ghp_|gho_|glpat-|xox[abp]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];
  const allowed = new Set(['localhost', '127.0.0.1', ...hosts]);
  const problems: string[] = [];
  for (const f of sourceFiles(dir)) {
    const rel = relative(ROOT, f);
    const text = readFileSync(f, 'utf8');
    const isTest = /(^|\/)test\.ts$|\/fixtures?\//.test(rel);
    if (!isTest && secret.some((re) => re.test(text))) problems.push(`${rel}: похоже на секрет в коде — учётные данные только из окружения`);
    if (!isTest && /from ['"](node:)?child_process['"]/.test(text)) problems.push(`${rel}: запуск процессов из коннектора запрещён`);
    if (!isTest) {
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = m[1]!.toLowerCase();
        if (!allowed.has(host) && !host.endsWith('.example') && !host.startsWith('connector-')) problems.push(`${rel}: адрес ${host} не объявлен в hosts теста`);
      }
    }
  }
  out.push(problems.length ? { ok: false, text: `код: ${problems.join('; ')}` } : { ok: true, text: 'код: нет секретов, чужих адресов и запуска процессов' });
  return out;
}

const freePort = () => new Promise<number>((res) => {
  const s = createServer().listen(0, () => {
    const { port } = s.address() as { port: number };
    s.close(() => res(port));
  });
});

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/** Точка входа коннектора: server.ts в корне каталога или в src/. */
const entryOf = (name: string) => ['server.ts', 'src/server.ts'].map((f) => join('connectors', name, f)).find((f) => existsSync(join(ROOT, f)));

async function runConnector(name: string, env: Record<string, string>): Promise<{ url: string; token: string; child: ChildProcess; logs: () => string }> {
  const port = await freePort();
  const token = randomBytes(16).toString('hex');
  let logs = '';
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entryOf(name)!], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? '', ...env, CONNECTOR_TOKEN: token, PORT: String(port) },
  });
  child.stdout!.on('data', (c) => (logs += c));
  child.stderr!.on('data', (c) => (logs += c));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`коннектор завершился при старте:\n${logs.trim().slice(-800)}`);
    if (await fetch(`${url}/healthz`).then((r) => r.ok, () => false)) return { url, token, child, logs: () => logs };
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill();
  throw new Error(`коннектор не ответил на /healthz за 20 с:\n${logs.trim().slice(-800)}`);
}

export async function validateConnector(name: string): Promise<{ ok: boolean; checks: Check[] }> {
  const dir = join(ROOT, 'connectors', name);
  const checks: Check[] = [];
  const add = (ok: Check['ok'], text: string) => checks.push({ ok, text });
  if (!entryOf(name)) return { ok: false, checks: [{ ok: false, text: `нет connectors/${name}/server.ts (или src/server.ts)` }] };
  if (!existsSync(join(dir, 'test.ts'))) {
    return { ok: false, checks: [{ ok: false, text: `нет connectors/${name}/test.ts — коннектор без проверки на тестовых данных не подключается` }] };
  }
  const test = (await import(join(dir, 'test.ts'))).default as ConnectorTest;
  const { registry, draft } = registryWithDraft(dir);
  checks.push(...staticChecks(dir, test.hosts ?? []));

  const system = await test.start();
  try {
    for (const v of test.variants) {
      const src = registry.sources[v.source];
      if (!src) {
        add(false, `${v.source}: нет ни в реестре, ни в черновике registry.draft.yaml`);
        continue;
      }
      const tag = `${v.source}${draft.has(v.source) ? ' (черновик реестра — ждёт одобрения человеком)' : ''}`;
      const conn = await runConnector(name, { ...system.env, ...v.env });
      const call = (path: string, body?: unknown, auth = true) => fetch(`${conn.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${conn.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      try {
        const noToken = await call('/query', { dataset: Object.keys(src.datasets)[0], fields: [], where: [], limit: 1 }, false);
        add(noToken.status === 401, `${tag}: без токена гейтвея — ${noToken.status === 401 ? 'отказ 401' : `ответ ${noToken.status}, ожидался 401`}`);

        const meta = (await (await call('/_meta')).json()) as { datasets: string[]; writes: string[] };
        const regWrites = Object.entries(registry.writes).filter(([, w]) => w.source === v.source).map(([id]) => id);
        const extra = meta.writes.filter((w) => !regWrites.includes(w));
        const lacking = regWrites.filter((w) => !meta.writes.includes(w));
        const dsLacking = Object.keys(src.datasets).filter((d) => !meta.datasets.includes(d));
        add(!extra.length, `${tag}: записи вне реестра — ${extra.length ? extra.join(', ') : 'нет'}`);
        add(!lacking.length && !dsLacking.length, `${tag}: всё из реестра есть в коннекторе${lacking.length || dsLacking.length ? ` — нет: ${[...dsLacking, ...lacking].join(', ')}` : ''}`);

        for (const [ds, d] of Object.entries(src.datasets)) {
          const fields = Object.keys(d.fields);
          const r = await call('/query', { dataset: ds, fields, where: [], limit: 3 });
          const rows = r.ok ? ((await r.json()) as { rows: Record<string, unknown>[] }).rows : null;
          const bad = rows?.find((row) => stable(Object.keys(row).sort()) !== stable([...fields].sort()));
          add(Boolean(rows) && !bad, `${tag}: набор ${ds} — ${!rows ? `ошибка ${r.status}` : bad ? `поля ${Object.keys(bad).join(',')} ≠ реестр ${fields.join(',')}` : `${rows.length} стр., ровно поля реестра`}`);
        }

        for (const sc of v.scenarios) {
          const before = await system.snapshot();
          const dr = await call(`/writes/${encodeURIComponent(sc.write)}/describe`, { params: sc.params });
          const summary = dr.ok ? ((await dr.json()) as { summary: string }).summary : '';
          const afterDescribe = await system.snapshot();
          add(dr.ok && Boolean(summary), `${sc.write}: describe — ${dr.ok ? `«${summary.slice(0, 90)}»` : `ошибка ${dr.status}: ${(await dr.text()).slice(0, 120)}`}`);
          add(stable(before) === stable(afterDescribe), `${sc.write}: describe ${stable(before) === stable(afterDescribe) ? 'ничего не меняет' : 'МЕНЯЕТ ДАННЫЕ — так нельзя'}`);
          const ar = await call(`/writes/${encodeURIComponent(sc.write)}/apply`, { params: sc.params, decided_by: 'validate', agent: null });
          const result = ar.ok ? ((await ar.json()) as { result: Record<string, unknown> }).result : {};
          const after = await system.snapshot();
          const problem = !ar.ok ? `ошибка ${ar.status}: ${(await ar.text()).slice(0, 120)}` : sc.expect?.(before, after, result);
          add(!problem, `${sc.write}: apply ${problem ? `— ${problem}` : 'сделал то, что ожидает сценарий'}`);
        }
        const covered = new Set(v.scenarios.map((s) => s.write));
        const uncovered = regWrites.filter((w) => !covered.has(w));
        if (uncovered.length) add('warn', `${tag}: apply без тестового сценария — ${uncovered.join(', ')}`);
      } finally {
        conn.child.kill();
      }
    }
  } finally {
    await system.stop();
  }
  return { ok: checks.every((c) => c.ok !== false), checks };
}

if (import.meta.main) {
  const name = process.argv[2];
  if (!name) {
    console.error('укажите коннектор: node packages/connector/src/validate.ts <имя>');
    process.exit(2);
  }
  validateConnector(name).then(
    ({ ok, checks }) => {
      for (const c of checks) console.log(`${c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗'} ${c.text}`);
      console.log(ok ? `\nконнектор ${name}: контракт соблюдён` : `\nконнектор ${name}: контракт нарушен`);
      process.exit(ok ? 0 : 1);
    },
    (e: Error) => {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    },
  );
}
