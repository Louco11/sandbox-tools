#!/bin/sh
# Публичный экспорт песочницы: платформа без тулов, без секретов и без личных данных.
#
#   make public                      → dist/public
#   sh infra/publish.sh [каталог]    → свой каталог
#
# Что делает и почему именно так:
#   * берёт только файлы под git (`git ls-files`) — незакоммиченное и мусор рабочей копии уехать не могут;
#   * выбрасывает tools/ целиком: тул принадлежит владельцу и стенду, между стендами он не переезжает;
#   * выбрасывает сгенерированные конфиги агентов и собирает их заново — в публичном репозитории есть
#     только сервер `sandbox`, серверов чужих тулов там быть не должно;
#   * заменяет личные данные (логин человека стенда, домашние пути) на нейтральные;
#   * кладёт публичные файлы из publish/: лицензию, английский README, SECURITY.md, заглушку tools/;
#   * ПРОВЕРЯЕТ результат и падает, если в нём нашлось запрещённое. Это главное: публикация необратима,
#     поэтому проверяет машина, а не внимательность.
#
# Скрипт ничего никуда не отправляет: он готовит каталог и печатает команды для пуша.
# Владелец копирайта — PUBLISH_COPYRIGHT (по умолчанию «internal-tools contributors»).
set -eu
cd "$(dirname "$0")/.."
ROOT=$(pwd -P)
OUT=${1:-dist/public}
HUMAN=${GITEA_HUMAN_USER:-$( (sed -n 's/^GITEA_HUMAN_USER=//p' .env 2>/dev/null || true) | tail -1)}
HUMAN=${HUMAN:-$(id -un | tr '[:upper:]' '[:lower:]')}
DEMO_PERSON=ivan.petrov      # нейтральный логин вместо человека стенда: он же в примерах AGENTS.md

die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
say() { printf '→ %s\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }

command -v git >/dev/null || die "нужен git"
command -v node >/dev/null || die "нужен node ≥ 22.18"
[ -f publish/LICENSE ] || die "нет publish/LICENSE — публичные файлы лежат в publish/"

# История публичного репозитория не переписывается: если она уже есть, обновление — обычный коммит.
say "каталог $OUT"
KEEP_GIT=
if [ -d "$OUT/.git" ]; then
  KEEP_GIT=$(mktemp -d)
  mv "$OUT/.git" "$KEEP_GIT/.git"
  say "история публичного репозитория сохраняется — это обновление, а не новый репозиторий"
fi
rm -rf "$OUT"
mkdir -p "$OUT"
[ -z "$KEEP_GIT" ] || { mv "$KEEP_GIT/.git" "$OUT/.git"; rmdir "$KEEP_GIT"; }

# 1. Файлы платформы: только отслеживаемые git, без тулов и сгенерированных конфигов агентов.
say "копирую платформу"
# Системы этого стенда (свой compose-файл, коннекторы и базы его источников) наружу не едут —
# как и тулы: у источника свой владелец, своя учётка и своё одобрение. Платформа публикуется без них.
STAND=$(node -e '
const { loadRegistry } = await import("./packages/manifest/src/index.ts");
const r = loadRegistry("registry/sources.yaml");
const names = Object.values(r.sources).map((s) => (s.connector?.url ?? "").replace(/^https?:\/\/connector-/, "").replace(/:\d+$/, ""));
console.log(names.filter(Boolean).join(" "));
' --input-type=module 2>/dev/null || true)
for n in $STAND; do say "система стенда «$n» в экспорт не уедет"; done

FILES=$(git ls-files \
  | grep -v '^docker-compose\.stand\.yml$' \
  | grep -v '^tools/' \
  | grep -v '^publish/' \
  | grep -v '^\.mcp\.json$' \
  | grep -v '^\.cursor/' \
  | grep -v '^opencode\.json$')
COUNT=0
for f in $FILES; do
  skip=
  for n in $STAND; do
    case "$f" in connectors/$n/*|infra/$n-db/*) skip=1 ;; esac
  done
  [ -z "$skip" ] || continue
  mkdir -p "$OUT/$(dirname "$f")"
  cp "$f" "$OUT/$f"
  COUNT=$((COUNT + 1))
done
ok "$COUNT файлов"

# 2. Описания: английский README впереди, русский рядом.
say "описания"
# Русский README уезжает как есть, но с врезкой: в публичном репозитории тулов нет, и сценарии это учитывают.
node --disable-warning=ExperimentalWarning -e '
const { readFileSync, writeFileSync } = require("node:fs");
const body = readFileSync(process.argv[1], "utf8").split("\n");
const head = readFileSync(process.argv[2], "utf8").trim();
const at = body.findIndex((l) => l.startsWith("# ")) + 1;
writeFileSync(process.argv[3], [...body.slice(0, at), "", head, ...body.slice(at)].join("\n"));
' "$OUT/README.md" publish/README.ru.head.md "$OUT/README.ru.md"
rm "$OUT/README.md"
cp publish/README.md "$OUT/README.md"
cp publish/SECURITY.md publish/LICENSE "$OUT/"
sed "s/\${YEAR}/$(date +%Y)/; s/internal-tools contributors/${PUBLISH_COPYRIGHT:-internal-tools contributors}/" publish/NOTICE > "$OUT/NOTICE"
mkdir -p "$OUT/tools"
cp publish/tools/README.md "$OUT/tools/"
# Источники стенда наружу не уезжают — как и тулы: у источника свой владелец, учётка и одобрение.
# В публичном репозитории реестр пуст, а потрогать песочницу можно демо-слоем (registry/demo/).
cp publish/registry/sources.yaml "$OUT/registry/sources.yaml"
# GitHub отклоняет пуш с .github/workflows, если у токена нет права `workflow`. Поэтому по умолчанию
# workflow не уезжает: PUBLISH_WORKFLOWS=1 — когда право выдано (gh auth refresh -h github.com -s workflow).
if [ "${PUBLISH_WORKFLOWS:-0}" = 1 ]; then
  mkdir -p "$OUT/.github/workflows"
  cp publish/.github/workflows/check.yml "$OUT/.github/workflows/"
fi
# Ссылки на русский README внутри него самого ведут на его новое имя.
ok "README.md (en), README.ru.md, SECURITY.md, LICENSE, NOTICE"

# 3. Личные данные стенда — на нейтральные. Список короткий и явный: что не перечислено, то и не заменяется.
say "обезличиваю"
# Заменяет node, а не sed: одинаково на macOS и Linux, и границы слова настоящие.
OUT="$OUT" HUMAN="$HUMAN" DEMO_PERSON="$DEMO_PERSON" node --disable-warning=ExperimentalWarning -e '
const { readdirSync, readFileSync, writeFileSync, statSync } = require("node:fs");
const { join, extname } = require("node:path");
const { OUT, HUMAN, DEMO_PERSON } = process.env;
const BINARY = new Set([".png", ".jpg", ".jpeg", ".ico", ".gz", ".pdf", ".woff", ".woff2"]);
const rules = [
  [/\/Users\/[A-Za-z0-9._-]+\/Projects\/Sandbox/g, "<путь к репозиторию>"],
  [/\/Users\/[A-Za-z0-9._-]+\/\.local\/bin\/node/g, "/usr/local/bin/node"],
  [new RegExp(`(^|[^A-Za-z0-9._-])${HUMAN}(?![A-Za-z0-9._-])`, "g"), `$1${DEMO_PERSON}`],
];
let touched = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== ".git") walk(p); continue; }
    if (BINARY.has(extname(e.name)) || statSync(p).size > 4e6) continue;
    const before = readFileSync(p, "utf8");
    const after = rules.reduce((s, [re, to]) => s.replace(re, to), before);
    if (after !== before) { writeFileSync(p, after); touched++; }
  }
};
walk(OUT);
console.log(`  \u001b[32m✓\u001b[0m ${HUMAN} → ${DEMO_PERSON}, домашние пути → плейсхолдер (${touched} файлов)`);
'

# 4. Конфиги агентов — заново, из пустого tools/: только сервер платформы.
say "конфиги агентов"
(cd "$OUT" && node --disable-warning=ExperimentalWarning infra/agents/sync.ts >/dev/null)
grep -q '"sandbox-' "$OUT/.mcp.json" && die "в конфиг агентов попал сервер тула"
ok ".mcp.json, .cursor/mcp.json, opencode.json — только sandbox"

# 4а. package-lock.json: без тулов. Иначе `npm ci` в публичном репозитории упадёт — в замке есть пакеты
# рабочих областей, которых там нет, да и имена чужих тулов наружу не нужны.
say "замок зависимостей"
OUT="$OUT" node --disable-warning=ExperimentalWarning -e '
const { readFileSync, writeFileSync } = require("node:fs");
const path = `${process.env.OUT}/package-lock.json`;
const lock = JSON.parse(readFileSync(path, "utf8"));
const gone = [];
for (const [name, pkg] of Object.entries(lock.packages ?? {})) {
  if (name.startsWith("tools/") || String(pkg?.resolved ?? "").startsWith("tools/")) {
    delete lock.packages[name];
    gone.push(name);
  }
}
writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`);
console.log(`  \u001b[32m✓\u001b[0m убрано записей тулов: ${gone.length}`);
'

# 5. Проверка. Дальше ничего не «исправляется» — любое срабатывание останавливает экспорт.
say "проверяю, что уезжает"
fail=0
check() { # check <описание> <regexp>
  # .git не проверяем: рефлог и индекс — местные файлы, они никуда не уезжают. Что уезжает в коммитах,
  # проверяется отдельно ниже (авторы) и самим содержимым дерева.
  found=$(grep -rIlE --exclude-dir=.git "$2" "$OUT" 2>/dev/null | sed "s|^$OUT/||" | head -5 || true)
  if [ -n "$found" ]; then
    printf '  \033[31m✗\033[0m %s: %s\n' "$1" "$(echo "$found" | tr '\n' ' ')" >&2
    fail=1
  else
    ok "$1 — нет"
  fi
}
[ -e "$OUT/.env" ] && { printf '  \033[31m✗\033[0m .env в экспорте\n' >&2; fail=1; } || ok ".env — нет"
[ -n "$(find "$OUT/tools" -name tool.yaml 2>/dev/null)" ] && { printf '  \033[31m✗\033[0m тул в экспорте\n' >&2; fail=1; } || ok "тулов — нет"
check "логин человека стенда" "(^|[^a-z0-9._-])${HUMAN}([^a-z0-9._-]|$)"
check "домашние каталоги" "/Users/[A-Za-z0-9._-]+/"
check "личная почта" "[A-Za-z0-9._%+-]+@(gmail|yandex|mail|outlook|icloud)\.[a-z]+"
check "приватные ключи" "BEGIN [A-Z ]*PRIVATE KEY"
SRC=$(node -e 'const {loadRegistry}=await import("./packages/manifest/src/index.ts");const r=loadRegistry(process.argv[1]);console.log(Object.keys(r.sources).length)' --input-type=module "$OUT/registry/sources.yaml" 2>/dev/null || echo '?')
if [ "$SRC" = 0 ]; then ok "источников стенда в экспорте — нет"; else printf '  \033[31m✗\033[0m в экспорт попали источники стенда: %s\n' "$SRC" >&2; fail=1; fi
check "присвоенные секреты" "^[A-Z_]{4,}=[A-Za-z0-9+/]{20,}$"
check "пароли и токены значением" "(password|secret|token|api_key)[\"']?[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9+/_-]{12,}[\"']"
# Кто подписан под уже опубликованными коммитами: это уезжает в GitHub и видно всем.
if [ -d "$OUT/.git" ] && (cd "$OUT" && git rev-parse -q --verify HEAD >/dev/null 2>&1); then
  WHO=$(cd "$OUT" && git log --format='%an <%ae>%n%cn <%ce>' | sort -u)
  if printf '%s' "$WHO" | grep -qE "@(gmail|yandex|mail|outlook|icloud)\."; then
    printf '  \033[31m✗\033[0m подпись коммитов: %s\n' "$(printf '%s' "$WHO" | tr '\n' ' ')" >&2
    fail=1
  else
    ok "подпись коммитов: $(printf '%s' "$WHO" | tr '\n' ' ')"
  fi
fi
[ "$fail" = 0 ] || die "экспорт остановлен: сначала уберите найденное"

# 6. Проверки самой платформы на чистом дереве: контракт допуска должен проходить и без тулов.
say "контракт допуска на чистом дереве"
(cd "$OUT" && node packages/manifest/src/cli.ts) | tail -1

# 7. Репозиторий под пуш: история одна, чужой e-mail в неё не попадает.
say "git"
(cd "$OUT" && { [ -d .git ] || git init -q -b main; } && git add -A)
SIZE=$(du -sh "$OUT" | cut -f1)
if [ -n "$KEEP_GIT" ]; then
  CHANGED=$(cd "$OUT" && git diff --cached --name-only | wc -l | tr -d ' ')
  cat <<TEXT

Готово: $OUT ($SIZE). Это обновление уже опубликованного репозитория: изменённых файлов — $CHANGED.

  cd $OUT
  git -c user.name="<имя>" -c user.email="<почта>" commit -m "<что изменилось>"
  git push

TEXT
else
  cat <<TEXT

Готово: $OUT ($SIZE, $(cd "$OUT" && git diff --cached --name-only | wc -l | tr -d ' ') файлов в индексе)

Дальше — вручную, чтобы вы видели, под каким именем публикуетесь:

  cd $OUT
  git -c user.name="<имя>" -c user.email="<почта для публичного репозитория>" \\
      commit -m "internal-tools: песочница внутренних тулов"
  gh repo create <владелец>/<репозиторий> --public --source=. --remote=origin --push
  # или: git remote add origin git@github.com:<владелец>/<репозиторий>.git && git push -u origin main

Перед пушем загляните в $OUT/README.md и $OUT/NOTICE: там имя владельца копирайта и описание репозитория.
TEXT
fi

if [ "${PUBLISH_WORKFLOWS:-0}" != 1 ]; then
  cat <<'TEXT'
Проверки GitHub Actions (.github/workflows/check.yml) в экспорт не попали: GitHub отклоняет пуш, если у токена
нет права `workflow`. Когда оно есть — gh auth refresh -h github.com -s workflow — соберите с PUBLISH_WORKFLOWS=1.
TEXT
fi
