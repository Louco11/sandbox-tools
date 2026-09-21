#!/bin/sh
# Развернуть песочницу на новом устройстве: только платформа, без тулов.
#
#   Исходное устройство:  make bundle                          → dist/sandbox-platform-<sha>.tar.gz
#   Новое устройство:     sh install.sh <источник> [каталог]   (по умолчанию ~/Projects/Sandbox)
#
# Источник — архив из `make bundle`, путь к рабочей копии песочницы или git-URL. Из него берётся
# только закоммиченный main без tools/. Тулы с устройством не переезжают: у тула есть владелец,
# срок жизни и история в гейтвее конкретного стенда, а на новом стенде их заводят заново через mcp-sandbox.
#
# Что НЕ переносится никогда: tools/*, .env и любые секреты, история git (в ней код тулов),
# данные Postgres и Gitea, регистрации тулов в гейтвее. Секреты генерируются заново (`make env`).
#
#   sh install.sh bundle [файл]   собрать архив платформы из текущей рабочей копии (то же, что make bundle)
#   sh install.sh --prepare-only <источник> [каталог]   подготовить каталог, стенд не поднимать
set -eu

say() { printf '→ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }
here=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd || true)

# ---------- архив платформы ---------------------------------------------------------------

# Платформа = закоммиченный main без tools/. Берём main из Gitea, если стенд поднят: там смерженные PR.
bundle() (
  src=$1 out=$2
  cd "$src"
  ref=main
  if [ -f .env ] && git remote get-url gitea >/dev/null 2>&1; then
    set -a; . ./.env; set +a
    auth=$(printf '%s:%s' "$GITEA_AGENT_USER" "$GITEA_AGENT_PASSWORD" | base64)
    if git -c credential.helper= -c http.extraHeader="Authorization: Basic $auth" fetch -q gitea main 2>/dev/null; then
      ref=refs/remotes/gitea/main
    fi
  fi
  git rev-parse -q --verify "$ref^{commit}" >/dev/null || die "в $src нет ветки main"
  sha=$(git rev-parse "$ref")
  [ -n "$out" ] || { mkdir -p dist; out="$PWD/dist/sandbox-platform-$(printf %.12s "$sha").tar.gz"; }
  tmp=$(mktemp -d)
  git archive --format=tar --prefix=sandbox/ "$ref" -- . ':(exclude)tools' | tar -x -C "$tmp"
  mkdir -p "$tmp/sandbox/tools"
  : > "$tmp/sandbox/tools/.gitkeep"
  printf '%s\n' "$sha" > "$tmp/sandbox/.platform-version"
  tar -czf "$out" -C "$tmp" sandbox
  rm -rf "$tmp"
  echo "$out"
)

if [ "${1:-}" = bundle ]; then
  out=$(bundle "${here:?}" "${2:-}")
  echo "Архив платформы (без тулов, секретов и истории): $out"
  echo "На новом устройстве:  tar -xzOf $(basename "$out") sandbox/infra/install.sh | sh -s -- $(basename "$out")"
  exit 0
fi

PREPARE_ONLY=
if [ "${1:-}" = --prepare-only ]; then PREPARE_ONLY=1; shift; fi
SOURCE=${1:-}
TARGET=${2:-$HOME/Projects/Sandbox}
[ -n "$SOURCE" ] || die "укажите источник: архив make bundle, путь к рабочей копии или git-URL"

# ---------- 1. окружение -----------------------------------------------------------------

say "проверка окружения"
for cmd in git node npm tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "нет $cmd"
done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "нужен Node ≥ 22.18, сейчас $(node -v)"
if [ -z "$PREPARE_ONLY" ]; then
for cmd in docker jq openssl curl make; do
  command -v "$cmd" >/dev/null 2>&1 || die "нет $cmd"
done
docker info >/dev/null 2>&1 || die "Docker не запущен"
docker compose version >/dev/null 2>&1 || die "нужен docker compose v2"

# Второй стенд на том же Docker сломал бы оба: имя проекта compose и тома общие.
if docker volume ls -q | grep -qE '^sandbox_(pgdata|gitea-data)$'; then
  die "на этом устройстве уже есть стенд песочницы (тома sandbox_*). Это установка на новое устройство;
  снести старый стенд вместе с данными: make reset в его каталоге"
fi
for port in 13000 12222 18000 18080 18090; do
  if command -v lsof >/dev/null && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then die "порт $port занят"; fi
done
fi
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then die "каталог $TARGET не пуст"; fi

# ---------- 2. платформа без тулов -------------------------------------------------------

say "платформа из $SOURCE"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
case "$SOURCE" in
  *.tar.gz|*.tgz)
    [ -f "$SOURCE" ] || die "нет файла $SOURCE"
    tar -xzf "$SOURCE" -C "$work"
    ;;
  *)
    if [ -d "$SOURCE/.git" ]; then repo=$SOURCE
    else git clone -q --branch main "$SOURCE" "$work/clone" || die "не удалось склонировать $SOURCE"; repo=$work/clone
    fi
    bundle "$repo" "$work/platform.tar.gz" >/dev/null
    tar -xzf "$work/platform.tar.gz" -C "$work"
    ;;
esac
[ -f "$work/sandbox/docker-compose.yml" ] && [ -f "$work/sandbox/AGENTS.md" ] || die "в источнике нет песочницы"

# Страховка для архивов, собранных не через bundle: тулы, секреты и состояние не переезжают.
rm -rf "$work/sandbox/tools" "$work/sandbox/.env" "$work/sandbox/.git" "$work/sandbox/node_modules" "$work/sandbox/dist"
mkdir -p "$work/sandbox/tools"
: > "$work/sandbox/tools/.gitkeep"

mkdir -p "$(dirname "$TARGET")"
mv "$work/sandbox" "$TARGET"
cd "$TARGET"
version=$(cat .platform-version 2>/dev/null || echo unknown)

say "зависимости (package-lock без тулов исходного стенда)"
# Сам npm записи удалённых воркспейсов не вычищает; версии остальных пакетов оставляем как на исходном стенде.
node -e '
  const fs = require("node:fs");
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const [k, v] of Object.entries(lock.packages ?? {})) {
    if (k.startsWith("tools/") || (v.link && String(v.resolved).startsWith("tools/"))) delete lock.packages[k];
  }
  fs.writeFileSync("package-lock.json", JSON.stringify(lock, null, 2) + "\n");
'
npm install --no-audit --no-fund --loglevel=error
node --disable-warning=ExperimentalWarning infra/agents/sync.ts >/dev/null

say "новая история git: код тулов исходного стенда в неё не попадает"
git init -q -b main
git add -A
git -c user.name="$(git config user.name || echo sandbox-install)" -c user.email="$(git config user.email || echo install@sandbox.local)" \
  commit -q -m "Песочница: платформа $(printf %.12s "$version") без тулов"

if [ -n "$PREPARE_ONLY" ]; then
  echo
  echo "Каталог $TARGET готов: платформа $(printf %.12s "$version"), тулов 0. Стенд не поднят — make up в этом каталоге."
  exit 0
fi

# ---------- 3. стенд ---------------------------------------------------------------------

say "стенд (make up: новые секреты, Gitea, гейтвей, деплоер)"
make up

say "проверка"
make check >/dev/null || die "make check не прошёл"
sha=$(git rev-parse HEAD)
i=0
until state=$(curl -s "http://localhost:18090/deploys/$sha" | jq -r .state) && [ "$state" = success ]; do
  [ "$state" = failure ] && die "деплоер не выкатил main: http://localhost:18090/deploys/$sha"
  i=$((i + 1)); [ $i -gt 120 ] && die "деплоер не обработал main за 6 минут: docker compose logs deployer"
  sleep 3
done
set -a; . ./.env; set +a
count=$(curl -s -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" http://localhost:18080/v1/admin/tools | jq '.tools | length')
[ "$count" = 0 ] || die "в гейтвее $count тулов, ожидалось 0"

echo
echo "Песочница развёрнута в $TARGET — платформа $(printf %.12s "$version"), тулов 0."
echo "  Главная:  http://tools.localhost:18000"
echo "  Gitea:    http://localhost:13000/platform/internal-tools"
echo "Дальше: задайте пароль своей учётной записи Gitea (команда выше, в выводе make up)"
echo "и откройте каталог в агенте — новый тул собирается через MCP-сервер sandbox (AGENTS.md)."
