/**
 * Контракт допуска в CI. Роняет сборку, если хоть один тул нарушает правила контура.
 *
 *   node packages/manifest/src/cli.ts              все тулы
 *   node packages/manifest/src/cli.ts <tool> ...   выбранные
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadRegistry } from './registry.ts';
import { loadDirectory } from './directory.ts';
import { parseManifestYaml } from './manifest.ts';

// Прямой путь к данным или в обход изоляции. Сеть и так закрыта; эта проверка
// нужна, чтобы агент узнал о нарушении сразу и с объяснением, а не по таймауту в рантайме.
const FORBIDDEN_DEPS = [
  'pg', 'postgres', 'pg-promise', 'mysql', 'mysql2', 'mongodb', 'mongoose', 'redis', 'ioredis',
  'knex', 'sequelize', 'typeorm', 'prisma', '@prisma/client', 'drizzle-orm', 'better-sqlite3', 'sqlite3',
  'kafkajs', 'amqplib',
];
const FORBIDDEN_IMPORTS = [...FORBIDDEN_DEPS, 'node:child_process', 'child_process', 'node:net', 'net', 'node:tls', 'tls', 'node:dgram', 'dgram'];
const REQUIRED_DEP = '@sandbox/sdk';

interface Problem {
  file: string;
  message: string;
}

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|js|mjs)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

function checkTool(root: string, tool: string, registry: ReturnType<typeof loadRegistry>): Problem[] {
  const dir = join(root, 'tools', tool);
  const manifestPath = join(dir, 'tool.yaml');
  const problems: Problem[] = [];
  const rel = (p: string) => relative(root, p);

  if (!existsSync(manifestPath)) return [{ file: rel(dir), message: 'нет tool.yaml — тул без манифеста в контур не попадает' }];

  const result = parseManifestYaml(readFileSync(manifestPath, 'utf8'), registry);
  if (!result.ok) {
    for (const e of result.errors) problems.push({ file: rel(manifestPath), message: `${e.path}: ${e.message}` });
  } else if (result.manifest.name !== tool) {
    problems.push({ file: rel(manifestPath), message: `name «${result.manifest.name}» не совпадает с папкой tools/${tool}` });
  }

  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) {
    problems.push({ file: rel(dir), message: 'нет package.json' });
  } else {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string> | undefined>;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const d of Object.keys(deps).filter((d) => FORBIDDEN_DEPS.includes(d))) {
      problems.push({ file: rel(pkgPath), message: `зависимость «${d}» запрещена: к данным — только через гейтвей (ctx.query в SDK)` });
    }
    if (!deps[REQUIRED_DEP]) problems.push({ file: rel(pkgPath), message: `тул должен строиться на ${REQUIRED_DEP}` });
  }

  if (!existsSync(join(dir, 'src', 'server.ts'))) problems.push({ file: rel(dir), message: 'нет src/server.ts — точки входа каркаса' });

  const importRe = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const file of [...sourceFiles(join(dir, 'src')), ...sourceFiles(join(dir, 'ui'))]) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importRe)) {
      if (FORBIDDEN_IMPORTS.includes(m[1]!)) {
        problems.push({ file: rel(file), message: `импорт «${m[1]}» запрещён в тулах: данные и сеть — только через SDK` });
      }
    }
  }
  return problems;
}

const root = process.cwd();
// Контракт допуска смотрит на тот же реестр, что и гейтвей: со включённым демо-слоем — вместе с ним.
const registry = loadRegistry(
  join(root, 'registry', 'sources.yaml'),
  process.env.SANDBOX_DEMO === '1' ? join(root, 'registry', 'demo', 'sources.yaml') : undefined,
);
// Справочник сотрудников: сломанный гейтвей не применит — ловим раньше, в CI.
try {
  loadDirectory(join(root, 'registry', 'directory.yaml'));
} catch (e) {
  console.log(`✗ registry/directory.yaml: ${(e as Error).message}`);
  process.exit(1);
}
const all = existsSync(join(root, 'tools'))
  ? readdirSync(join(root, 'tools'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
const selected = process.argv.slice(2);
const tools = selected.length ? selected : all;

let failed = 0;
for (const tool of tools) {
  const problems = checkTool(root, tool, registry);
  if (!problems.length) {
    console.log(`✓ ${tool}`);
    continue;
  }
  failed++;
  console.log(`✗ ${tool}`);
  for (const p of problems) {
    console.log(`    ${p.file}: ${p.message}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error file=${p.file}::${p.message}`);
  }
}

console.log(`\n${tools.length - failed} из ${tools.length} тулов прошли контракт допуска`);
process.exit(failed ? 1 : 0);
