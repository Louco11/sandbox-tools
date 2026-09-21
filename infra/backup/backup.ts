/**
 * Бэкап и восстановление стенда песочницы.
 *
 *   make backup                         снять бэкап в SANDBOX_BACKUP_DIR и почистить старые (7 ежедневных + 4 еженедельных)
 *   make backup-verify [FILE=…]         восстановить бэкап во временный Postgres и сверить с манифестом (по умолчанию — последний)
 *   make restore FILE=… [ADOPT=1]       восстановить стенд. Только человек, в терминале, с подтверждением
 *   make backup-schedule                ежедневный бэкап в 03:00 (launchd на macOS, строка crontab на Linux)
 *
 * Что в бэкапе (архив шифруется ключом SANDBOX_BACKUP_KEY_FILE, ключ хранит человек вне устройства):
 *   gitea.tar.gz    том Gitea: код, ветки, PR и одобрения человека — журнал решений
 *   sources.dump    данные источников (схемы — из registry/sources.yaml)
 *   audit.csv       audit.calls — при восстановлении только дописывается, никогда не откатывается
 *   gateway.dump    регистрации тулов: сроки жизни, простой, неподтверждённые записи
 * Чего в бэкапе нет: .env и любых секретов, образов и контейнеров тулов, состояния деплоера и раннера —
 * секреты у каждого стенда свои, а остальное выводится из git.
 *
 * Условия восстановления:
 *   - тот же стенд (SANDBOX_STAND_ID совпадает) — восстанавливается всё;
 *   - другой стенд (новое устройство после install.sh) — данные источников и аудит; Gitea и тулы — только
 *     с ADOPT=1, это решение владельца тулов. Сроки жизни — как были: восстановление не продлевает тулы,
 *     истёкшие за это время гейтвей не допустит, уборщик удалит;
 *   - аудит объединяется: записи новее бэкапа сохраняются, записи из бэкапа дописываются, если их нет.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FORMAT = 1;
const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4;

// ---------- окружение -------------------------------------------------------------------------

function die(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}
const say = (s: string) => console.log(`→ ${s}`);

function dotenv(): Record<string, string> {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) die('нет .env — стенд не поднят (make up)');
  return Object.fromEntries(
    readFileSync(path, 'utf8').split('\n').filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
  );
}
// SANDBOX_BACKUP_* можно задать и в окружении (например, из launchd или для разового бэкапа в другое место).
const env: Record<string, string | undefined> = { ...dotenv(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SANDBOX_BACKUP_'))) };
const STAND_ID = env.SANDBOX_STAND_ID ?? die('нет SANDBOX_STAND_ID в .env — выполните make env');
const expand = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const KEY_FILE = expand(env.SANDBOX_BACKUP_KEY_FILE || '~/.config/sandbox/backup.key');

function run(cmd: string, args: string[], opts: SpawnSyncOptions & { input?: string } = {}): string {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30, ...opts });
  if (r.status !== 0) die(`${cmd} ${args.slice(0, 3).join(' ')}…: ${String(r.stderr ?? '').trim() || `код ${r.status}`}`);
  return String(r.stdout ?? '');
}
/** Команда, чей stdout целиком пишется в файл (дампы бывают большими). */
function runToFile(file: string, cmd: string, args: string[]): void {
  const fd = openSync(file, 'w', 0o600);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', fd, 'pipe'], encoding: 'utf8' });
  closeSync(fd);
  if (r.status !== 0) die(`${cmd} ${args.slice(0, 4).join(' ')}…: ${r.stderr.trim()}`);
}
const compose = (...args: string[]) => ['compose', ...args];
const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function backupDir(): string {
  const raw = env.SANDBOX_BACKUP_DIR;
  if (!raw) die('не задан SANDBOX_BACKUP_DIR в .env — каталог на внешнем диске или NAS');
  const dir = expand(raw);
  if (!existsSync(dir)) die(`каталог бэкапов ${dir} недоступен — внешний диск или NAS не подключён? Бэкап не сделан`);
  if (resolve(dir).startsWith(ROOT)) die('бэкапы нельзя хранить внутри репозитория');
  // Бэкап на том же диске не переживает потерю устройства.
  if (statSync(dir).dev === statSync(ROOT).dev && env.SANDBOX_BACKUP_ALLOW_SAME_DISK !== '1') {
    die(`${dir} на том же диске, что и стенд — потеря устройства унесёт и бэкапы. Нужен внешний диск или NAS`);
  }
  return dir;
}

function key(create: boolean): string {
  if (!existsSync(KEY_FILE)) {
    if (!create) die(`нет ключа ${KEY_FILE} — восстановите его из менеджера паролей`);
    mkdirSync(join(KEY_FILE, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(KEY_FILE, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    console.log(`\n! Создан ключ бэкапов ${KEY_FILE}.\n  Сохраните его содержимое в менеджер паролей: без ключа бэкап не восстановить, а с устройством он пропадёт.\n`);
  }
  chmodSync(KEY_FILE, 0o600);
  return KEY_FILE;
}
const keyId = (file: string) => createHash('sha256').update(readFileSync(file, 'utf8').trim()).digest('hex').slice(0, 12);

// ---------- Postgres ------------------------------------------------------------------------

const PSQL = ['exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'sources_admin', '-d', 'sources', '-qAt'];

interface Pg { exec(args: string[]): string[]; sql(sql: string): string; cp(file: string): string; dump(file: string, args: string[]): void }

/** Стендовый Postgres (docker compose) или временный контейнер проверки — одинаковые операции. */
function pgOf(container: string | null): Pg {
  const exec = (args: string[]) => (container ? ['exec', '-i', container, ...args] : [...compose('exec', '-T', 'postgres'), ...args]);
  return {
    exec,
    sql: (sql) => run('docker', exec(['psql', '-v', 'ON_ERROR_STOP=1', '-U', 'sources_admin', '-d', 'sources', '-qAt']), { input: sql }).trim(),
    cp(file) {
      const target = `/tmp/${basename(file)}`;
      run('docker', container ? ['cp', file, `${container}:${target}`] : [...compose('cp', file, `postgres:${target}`)]);
      return target;
    },
    dump: (file, args) => runToFile(file, 'docker', exec(['pg_dump', '-U', 'sources_admin', '-d', 'sources', ...args])),
  };
}

/**
 * Схемы данных источников в Postgres стенда — всё, кроме служебных (audit и gateway бэкапятся отдельно). Берутся из
 * самой базы: коннекторы держат таблицы у себя, реестр о них не знает. Данные внешних систем коннекторов бэкапит их владелец.
 */
function sourceSchemas(pg: Pg): string[] {
  return pg.sql(`SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('public', 'audit', 'gateway', 'information_schema') AND nspname NOT LIKE 'pg\\_%' ORDER BY 1`)
    .split('\n').filter(Boolean);
}

function counts(pg: Pg): Record<string, number> {
  const tables = pg.sql(
    `SELECT table_schema || '.' || table_name FROM information_schema.tables
      WHERE table_schema IN ('${[...sourceSchemas(pg), 'audit', 'gateway'].join("','")}') AND table_type = 'BASE TABLE' ORDER BY 1`,
  ).split('\n').filter(Boolean);
  return Object.fromEntries(tables.map((t) => [t, Number(pg.sql(`SELECT count(*) FROM ${t}`))]));
}

/** Данные источников и (по условию) регистрации тулов: заменить целиком. Аудит: только дописать недостающее. */
function restorePostgres(pg: Pg, dir: string, withGateway: boolean, note: string): void {
  const truncate = (schemas: string[]) => pg.sql(`
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT format('%I.%I', table_schema, table_name) FROM information_schema.tables
               WHERE table_schema IN ('${schemas.join("','")}') AND table_type = 'BASE TABLE'
      LOOP EXECUTE 'TRUNCATE ' || t || ' RESTART IDENTITY CASCADE'; END LOOP;
    END $$;`);
  const load = (file: string) =>
    run('docker', pg.exec(['pg_restore', '-U', 'sources_admin', '-d', 'sources', '--data-only', '--disable-triggers', '--single-transaction', pg.cp(join(dir, file))]));

  truncate(sourceSchemas(pg));
  load('sources.dump');
  if (withGateway) {
    truncate(['gateway']);
    load('gateway.dump');
  }

  const csv = pg.cp(join(dir, 'audit.csv'));
  const cols = 'at, request_id, actor, tool, source, operation, fields, agent_in_chain, allowed, reason';
  pg.sql(`
    BEGIN;
    CREATE TEMP TABLE restored (LIKE audit.calls);
    \\copy restored FROM '${csv}' WITH (FORMAT csv, HEADER)
    INSERT INTO audit.calls (${cols})
      SELECT ${cols} FROM restored r
       WHERE NOT EXISTS (SELECT 1 FROM audit.calls c
                          WHERE c.request_id = r.request_id AND c.at = r.at AND c.operation = r.operation AND c.tool = r.tool)
       ORDER BY r.at, r.id;
    INSERT INTO audit.calls (request_id, actor, tool, operation, agent_in_chain, allowed, reason)
      VALUES ('restore-${stamp()}', '${userInfo().username.toLowerCase().replace(/[^a-z0-9._-]/g, '')}', '(platform)', 'backup.restore', false, true, ${pgText(note)});
    COMMIT;`);
}
const pgText = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ---------- бэкап -------------------------------------------------------------------------

function backup(): void {
  const dir = backupDir();
  const keyFile = key(true);
  const res = spawnSync('curl', ['-sf', 'http://localhost:18080/healthz']);
  if (res.status !== 0) die('стенд не отвечает (гейтвей) — бэкап снимается с работающего стенда');

  const work = mkdtempSync(join(tmpdir(), 'sandbox-backup-'));
  try {
    const pg = pgOf(null);
    say('Postgres: данные источников, регистрации тулов, аудит');
    pg.dump(join(work, 'sources.dump'), ['-Fc', '--data-only', ...sourceSchemas(pg).flatMap((s) => ['-n', s])]);
    pg.dump(join(work, 'gateway.dump'), ['-Fc', '--data-only', '-n', 'gateway']);
    runToFile(join(work, 'audit.csv'), 'docker', [...compose(...PSQL), '-c', 'COPY (SELECT * FROM audit.calls ORDER BY id) TO STDOUT WITH (FORMAT csv, HEADER)']);
    const pgCounts = counts(pg);
    const tools = pg.sql(`SELECT name || '|' || owner || '|' || expires_at || '|' || (revoked_at IS NOT NULL) FROM gateway.tools ORDER BY name`)
      .split('\n').filter(Boolean).map((l) => {
        const [name, owner, expires_at, revoked] = l.split('|');
        return { name, owner, expires_at, revoked: revoked === 't' };
      });

    // SQLite Gitea копируется согласованно только остановленной: несколько секунд простоя Gitea и CI.
    say('Gitea: том целиком (Gitea остановлена на время копирования)');
    run('docker', compose('stop', 'gitea'));
    try {
      runToFile(join(work, 'gitea.tar.gz'), 'docker', ['run', '--rm', '-v', 'sandbox_gitea-data:/data:ro', 'node:22-bookworm-slim', 'tar', '-czf', '-', '-C', '/data', '.']);
    } finally {
      run('docker', compose('up', '-d', '--wait', 'gitea'));
    }

    const files = ['gitea.tar.gz', 'sources.dump', 'gateway.dump', 'audit.csv'];
    const platform = spawnSync('git', ['rev-parse', 'refs/remotes/gitea/main'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || null;
    const manifest = {
      format: FORMAT, stand_id: STAND_ID, created_at: new Date().toISOString(), host: hostname(), platform,
      tools, counts: pgCounts, files: Object.fromEntries(files.map((f) => [f, sha256(join(work, f))])),
    };
    writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));

    say('шифрование и запись');
    const name = `sandbox-${STAND_ID.slice(0, 8)}-${stamp()}.tar.enc`;
    const partial = join(dir, `.${name}.partial`);
    const tar = spawnSync('sh', ['-c', `tar -cf - -C "$1" manifest.json ${files.join(' ')} | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass file:"$2" -out "$3"`, 'sh', work, keyFile, partial], { encoding: 'utf8' });
    if (tar.status !== 0) {
      rmSync(partial, { force: true });
      die(`шифрование: ${tar.stderr.trim()}`);
    }
    // Рядом — несекретная карточка: чей бэкап, каким ключом, контрольная сумма. Имён тулов и людей в ней нет.
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({
      format: FORMAT, stand_id: STAND_ID, created_at: manifest.created_at, key_id: keyId(keyFile),
      sha256: sha256(partial), tools: tools.filter((t) => !t.revoked).length, audit_rows: pgCounts['audit.calls'],
    }, null, 2));
    chmodSync(partial, 0o600);
    chmodSync(join(dir, `${name}.json`), 0o600);
    renameSync(partial, join(dir, name)); // до переименования неполный файл не выглядит бэкапом
    console.log(`✓ ${join(dir, name)} (${(statSync(join(dir, name)).size / 1e6).toFixed(1)} МБ)`);
    prune(dir);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 7 последних ежедневных + последний бэкап каждой из 4 последних недель. Чужие стенды не трогаем. */
function prune(dir: string): void {
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`sandbox-${STAND_ID.slice(0, 8)}-`) && f.endsWith('.tar.enc'))
    .sort()
    .reverse();
  const day = (f: string) => f.match(/-(\d{8})-\d{6}\.tar\.enc$/)?.[1] ?? '';
  const week = (f: string) => {
    const d = day(f);
    const date = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)));
    return Math.floor((date.getTime() / 86_400_000 + 3) / 7); // номер недели от эпохи, неделя с понедельника
  };
  const keep = new Set<string>();
  const days = new Set<string>();
  for (const f of mine) if (!days.has(day(f)) && days.size < KEEP_DAILY) { days.add(day(f)); keep.add(f); }
  const weeks = new Set<number>();
  for (const f of mine) if (!weeks.has(week(f)) && weeks.size < KEEP_WEEKLY) { weeks.add(week(f)); keep.add(f); }
  for (const f of mine.filter((f) => !keep.has(f))) {
    unlinkSync(join(dir, f));
    rmSync(join(dir, `${f}.json`), { force: true });
    say(`удалён старый бэкап ${f}`);
  }
}

// ---------- чтение бэкапа -------------------------------------------------------------------

interface Card { stand_id: string; created_at: string; key_id: string; sha256: string }
interface Manifest { stand_id: string; created_at: string; host: string; platform: string | null; tools: { name: string; owner: string; expires_at: string; revoked: boolean }[]; counts: Record<string, number>; files: Record<string, string> }

function latest(): string {
  const dir = backupDir();
  const all = readdirSync(dir).filter((f) => f.endsWith('.tar.enc')).sort();
  if (!all.length) die(`в ${dir} нет бэкапов`);
  return join(dir, all.at(-1)!);
}

function open(file: string): { dir: string; manifest: Manifest } {
  if (!existsSync(file)) die(`нет файла ${file}`);
  const cardFile = `${file}.json`;
  if (!existsSync(cardFile)) die(`нет карточки ${basename(cardFile)} рядом с бэкапом`);
  const card = JSON.parse(readFileSync(cardFile, 'utf8')) as Card;
  if (sha256(file) !== card.sha256) die('контрольная сумма не совпадает: файл бэкапа повреждён или подменён');
  const keyFile = key(false);
  if (keyId(keyFile) !== card.key_id) die(`бэкап зашифрован другим ключом (key_id ${card.key_id}, у вас ${keyId(keyFile)})`);

  const dir = mkdtempSync(join(tmpdir(), 'sandbox-restore-'));
  const r = spawnSync('sh', ['-c', 'openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass file:"$1" -in "$2" | tar -xf - -C "$3"', 'sh', keyFile, file, dir], { encoding: 'utf8' });
  if (r.status !== 0) die(`расшифровка: ${r.stderr.trim()}`);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Manifest;
  for (const [f, sum] of Object.entries(manifest.files)) {
    if (sha256(join(dir, f)) !== sum) die(`${f}: контрольная сумма не совпадает с манифестом`);
  }
  return { dir, manifest };
}

// ---------- проверка: восстановить во временный Postgres ------------------------------------

function verify(file: string): void {
  say(`проверка ${basename(file)}`);
  const { dir, manifest } = open(file);
  const name = `sandbox-backup-verify-${process.pid}`;
  try {
    // Чистый Postgres из тех же init-скриптов, без сети; пароли ролей для проверки не важны.
    const pgEnv = Object.keys(env).filter((k) => k.startsWith('PG_')).flatMap((k) => ['-e', `${k}=verify`]);
    run('docker', ['run', '-d', '--rm', '--name', name, '--network', 'none', '-e', 'POSTGRES_DB=sources', '-e', 'POSTGRES_USER=sources_admin',
      '-e', 'POSTGRES_PASSWORD=verify', ...pgEnv, '-v', `${join(ROOT, 'infra/postgres/init')}:/docker-entrypoint-initdb.d:ro`, 'postgres:17-alpine']);
    const pg = pgOf(name);
    for (let i = 0; ; i++) {
      const ready = spawnSync('docker', ['exec', name, 'psql', '-U', 'sources_admin', '-d', 'sources', '-qAt', '-c',
        "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = 'sources'"], { encoding: 'utf8' });
      if (ready.stdout?.trim() === 'seed:ok') break;
      if (i > 60) die('временный Postgres не поднялся');
      spawnSync('sleep', ['1']);
    }
    restorePostgres(pg, dir, true, 'проверка бэкапа');
    const got = counts(pg);
    const bad = Object.entries(manifest.counts)
      .map(([t, n]) => [t, n, (got[t] ?? 0) - (t === 'audit.calls' ? 1 : 0)] as const) // +1 — запись о самом восстановлении
      .filter(([, want, have]) => want !== have);
    if (bad.length) die(`после восстановления не сходится: ${bad.map(([t, w, h]) => `${t} ${h}≠${w}`).join(', ')}`);
    const gitea = run('tar', ['-tzf', join(dir, 'gitea.tar.gz')]);
    if (!gitea.includes('gitea/gitea.db')) die('в архиве Gitea нет gitea.db');
    const active = manifest.tools.filter((t) => !t.revoked);
    console.log(`✓ бэкап восстанавливается: стенд ${manifest.stand_id.slice(0, 8)}, ${manifest.created_at}, ` +
      `строк аудита ${manifest.counts['audit.calls']}, тулов ${active.length}${active.length ? ` (${active.map((t) => t.name).join(', ')})` : ''}`);
  } finally {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- восстановление стенда ------------------------------------------------------------

function ask(question: string): string {
  process.stdout.write(question);
  const buf = Buffer.alloc(256);
  const n = readSyncStdin(buf);
  return buf.subarray(0, n).toString('utf8').trim();
}
function readSyncStdin(buf: Buffer): number {
  try {
    return readSync(0, buf, 0, buf.length, null);
  } catch {
    return 0;
  }
}

function restore(file: string, adopt: boolean): void {
  // Восстановление перезаписывает данные стенда — это решение человека. Агент в неинтерактивной оболочке сюда не пройдёт.
  if (!process.stdin.isTTY) die('восстановление запускает человек в терминале: make restore FILE=…');
  const { dir, manifest } = open(file);
  try {
    const same = manifest.stand_id === STAND_ID;
    const withGitea = same || adopt;
    const active = manifest.tools.filter((t) => !t.revoked);
    const now = Date.now();

    console.log(`\nБэкап стенда ${manifest.stand_id.slice(0, 8)} от ${manifest.created_at} (${manifest.host}); этот стенд — ${STAND_ID.slice(0, 8)}.`);
    console.log('Будет восстановлено:');
    console.log('  • данные источников (tasks, knowledge, boards) — заменят текущие');
    console.log(`  • аудит — допишутся записи из бэкапа, которых нет (сейчас записи не удаляются)`);
    if (withGitea) {
      console.log('  • Gitea целиком (код, ветки, PR) — заменит текущую');
      console.log(`  • тулы: ${active.length ? '' : 'нет'}`);
      for (const t of active) {
        const expired = new Date(t.expires_at).getTime() <= now;
        console.log(`      ${t.name.padEnd(32)} владелец ${t.owner.padEnd(14)} ${expired ? 'срок истёк — будет удалён уборщиком' : `до ${t.expires_at.slice(0, 10)}`}`);
      }
    } else {
      console.log(`  • Gitea и тулы (${active.length}) — НЕТ: бэкап другого стенда, тулы с устройством не переезжают.`);
      console.log('    Вернуть тулы может их владелец: make restore FILE=… ADOPT=1');
    }
    if (!same && adopt) console.log('\n  ADOPT: тулы другого стенда переходят сюда со сроками как были. Это решение владельцев тулов выше.');

    const word = adopt && !same ? 'ПЕРЕНЕСТИ ТУЛЫ' : 'ВОССТАНОВИТЬ';
    if (ask(`\nНаберите «${word}», чтобы продолжить: `) !== word) die('отменено');

    const note = `${basename(file)}; стенд ${manifest.stand_id.slice(0, 8)} → ${STAND_ID.slice(0, 8)}; ` +
      (withGitea ? `Gitea и тулы восстановлены (${active.map((t) => t.name).join(', ') || 'нет'})` : 'только данные и аудит') + (adopt && !same ? '; adopt' : '');

    say('Postgres');
    restorePostgres(pgOf(null), dir, withGitea, note);

    if (withGitea) {
      say('Gitea');
      run('docker', compose('stop', 'gitea', 'runner'));
      const tarFile = join(dir, 'gitea.tar.gz');
      run('docker', ['run', '--rm', '-i', '-v', 'sandbox_gitea-data:/data', 'node:22-bookworm-slim', 'sh', '-c', 'find /data -mindepth 1 -delete && tar -xzf - -C /data'], { input: undefined, stdio: [openSync(tarFile, 'r'), 'pipe', 'pipe'] });
      // Раннер зарегистрирован в прежней Gitea: пусть зарегистрируется заново по токену из .env.
      run('docker', ['run', '--rm', '-v', 'sandbox_runner-data:/data', 'node:22-bookworm-slim', 'rm', '-f', '/data/.runner']);
      run('docker', compose('up', '-d', '--wait', 'gitea'));
      // Пароли служебных учёток — из .env этого стенда, а не из бэкапа. Пароль человека — его, из бэкапа.
      for (const [user, password] of [[env.GITEA_ADMIN_USER, env.GITEA_ADMIN_PASSWORD], [env.GITEA_AGENT_USER, env.GITEA_AGENT_PASSWORD], [env.GITEA_DEPLOYER_USER, env.GITEA_DEPLOYER_PASSWORD]]) {
        if (user && password) spawnSync('docker', [...compose('exec', '-T', '-u', 'git', 'gitea', 'gitea', 'admin', 'user', 'change-password', '--username', user, '--password', password, '--must-change-password=false')], { cwd: ROOT, stdio: 'ignore' });
      }
      run('docker', compose('up', '-d', 'runner'));
      run('sh', ['infra/bootstrap.sh']);

      // Деплоер выкатит main восстановленной Gitea заново: секреты тулов ротируются, истёкшие гейтвей не допустит.
      say('деплоер: выкатка main восстановленной Gitea');
      // Журнал выкаток оставляем: по нему деплоер отзывает превью удалённых веток.
      run('docker', compose('exec', '-T', 'deployer', 'rm', '-f', '/state/done.json'));
      run('docker', compose('restart', 'deployer'));
    }

    console.log(`\n✓ восстановлено из ${basename(file)}`);
    if (withGitea) {
      console.log('  Рабочая копия не тронута. Чтобы привести её к восстановленной Gitea (локальные изменения пропадут):');
      console.log('    git fetch gitea && git reset --hard gitea/main');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- расписание ----------------------------------------------------------------------

function schedule(): void {
  const log = join(homedir(), 'Library', 'Logs', 'sandbox-backup.log');
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', 'local.sandbox.backup.plist');
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.sandbox.backup</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>cd '${ROOT}' &amp;&amp; make backup</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`);
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    run('launchctl', ['load', plist]);
    console.log(`✓ ежедневный бэкап в 03:00 (если Mac спал — при пробуждении): ${plist}\n  лог: ${log}\n  отключить: launchctl unload ${plist} && rm ${plist}`);
  } else {
    console.log(`Добавьте в crontab -e:\n  0 3 * * * cd '${ROOT}' && make backup >> '${join(homedir(), 'sandbox-backup.log')}' 2>&1`);
  }
}

// ---------- точка входа ---------------------------------------------------------------------

const [cmd, arg, flag] = process.argv.slice(2);
switch (cmd) {
  case 'backup': backup(); break;
  case 'verify': verify(arg ? resolve(arg) : latest()); break;
  case 'restore': if (!arg) die('укажите файл: make restore FILE=…'); restore(resolve(arg), flag === '--adopt-tools'); break;
  case 'schedule': schedule(); break;
  default: die('команды: backup | verify [файл] | restore <файл> [--adopt-tools] | schedule');
}
