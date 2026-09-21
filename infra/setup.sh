#!/bin/sh
# Первый запуск песочницы в этой копии — то, что агент делает в свежескачанном репозитории.
#
#   sh infra/setup.sh            проверить окружение и поднять стенд
#   sh infra/setup.sh --check    только проверить окружение, ничего не менять
#
# Скрипт идемпотентен: на поднятом стенде он ничего не ломает, а досоздаёт недостающее и проверяет здоровье.
# Секреты он создаёт локально (.env, в git не попадает) и никуда не отправляет.
#
# Чего скрипт НЕ делает, потому что это решение человека: не меняет пароли, не открывает стенд в сеть
# (`make lan`), не создаёт тулы. Первый тул собирает агент через MCP-сервер `sandbox` — см. AGENTS.md.
set -eu
cd "$(dirname "$0")/.."

CHECK_ONLY=
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

red() { printf '\033[31m%s\033[0m\n' "$*"; }
die() { red "✗ $*" >&2; exit 1; }
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

# ---------- 1. окружение -----------------------------------------------------------------

say "1. Окружение"
problems=0
need() {
  if command -v "$1" >/dev/null 2>&1; then ok "$1"; else no "$1 — $2"; problems=$((problems + 1)); fi
}
need docker "поставьте Docker Desktop (или docker + compose v2)"
need node   "поставьте Node ≥ 22.18 — он запускает TypeScript без сборки"
need npm    "идёт вместе с Node"
need git    "нужен для веток и PR: агент пушит ветку, CI её проверяет"
need jq     "нужен демо-сценариям и bootstrap (brew install jq / apt install jq)"
need curl   "нужен для проверок здоровья"

if command -v node >/dev/null 2>&1; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
    && ok "версия Node $(node -v)" \
    || { no "нужен Node ≥ 22.18, сейчас $(node -v)"; problems=$((problems + 1)); }
fi
if command -v docker >/dev/null 2>&1; then
  docker info >/dev/null 2>&1 && ok "Docker запущен" || { no "Docker не запущен — запустите Docker Desktop"; problems=$((problems + 1)); }
  docker compose version >/dev/null 2>&1 && ok "docker compose v2" || { no "нужен docker compose v2"; problems=$((problems + 1)); }
fi

# Порты стенда. Занятый порт — не всегда беда: это может быть сам стенд, поднятый раньше.
say "2. Порты"
RUNNING=$(docker compose ps --status running -q 2>/dev/null | wc -l | tr -d ' ')
for port in 13000:Gitea 12222:'Gitea SSH' 18000:'витрина и главная' 18080:гейтвей 18090:деплоер; do
  p=${port%%:*}; what=${port#*:}
  if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    if [ "$RUNNING" != 0 ]; then ok "$p ($what) — занят стендом, который уже поднят"
    else no "$p ($what) занят чужим процессом: lsof -nP -iTCP:$p -sTCP:LISTEN"; problems=$((problems + 1)); fi
  else
    ok "$p ($what) свободен"
  fi
done

[ "$problems" = 0 ] || die "$problems проблем(ы) с окружением — поправьте и запустите снова"

if [ -n "$CHECK_ONLY" ]; then
  say "Окружение готово"
  echo "  Поднять стенд: sh infra/setup.sh   (или make up)"
  exit 0
fi

# ---------- 2. зависимости и стенд -------------------------------------------------------

say "3. Зависимости"
if [ -d node_modules ]; then
  ok "node_modules уже есть"
else
  npm install --no-audit --no-fund --loglevel=error
  ok "npm install"
fi

say "4. Контракт допуска"
node packages/manifest/src/cli.ts | tail -1

say "5. Стенд (make up: секреты в .env, Postgres, гейтвей, Gitea, IdP, деплоер, уборщик)"
echo "  Первый запуск собирает образы — это несколько минут."
make up

# ---------- 3. проверка ------------------------------------------------------------------

say "6. Проверка здоровья"
DOMAIN=$( (sed -n 's/^SANDBOX_DOMAIN=//p' .env 2>/dev/null || true) | tail -1)
DOMAIN=${DOMAIN:-tools.localhost}
alive() { # alive <что> <url> [ожидаемые коды: 200|401|…]
  want=${3:-200}
  i=0
  while :; do
    code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$2" 2>/dev/null || echo 000)
    # Разделитель в переменной: в POSIX sh «|» внутри $want не работает как альтернатива в case.
    case "|$want|" in
      *"|$code|"*) ok "$1"; return 0 ;;
    esac
    i=$((i + 1)); [ $i -gt 20 ] && { no "$1 не отвечает ($code): $2"; return 1; }
    sleep 3
  done
}
fail=0
alive "гейтвей"  "http://localhost:18080/v1/registry"  || fail=1
# Главная закрыта входом, поэтому без сессии 401 — это и есть признак, что ForwardAuth работает.
alive "главная (вход спрашивает IdP)" "http://$DOMAIN:18000/healthz" '200|401|302' || fail=1
alive "личность" "http://id.$DOMAIN:18000/healthz"     || fail=1
alive "деплоер"  "http://localhost:18090/healthz"      || fail=1
alive "Gitea"    "http://localhost:13000/api/healthz"  || fail=1
[ "$fail" = 0 ] || die "стенд поднялся не полностью: docker compose ps, docker compose logs <сервис>"

set -a; . ./.env; set +a
# Считаем живые прод-инстансы: на свежем стенде их 0, и это правильный ответ.
TOOLS=$(curl -s -H "Authorization: Bearer ${GATEWAY_ADMIN_TOKEN:-}" http://localhost:18080/v1/admin/tools \
  | jq '[.tools[] | select(.revoked_at == null and (.name | contains("--") | not))] | length' 2>/dev/null || echo '?')
ok "живых тулов в контуре: $TOOLS"

# ---------- 4. что дальше ----------------------------------------------------------------

cat <<TEXT

$(printf '\033[1m%s\033[0m' "Песочница развёрнута.")

  Главная      http://$DOMAIN:18000
  Вход (IdP)   http://auth.$DOMAIN:18000 — логин ${GITEA_HUMAN_USER:-вы}, временный пароль KEYCLOAK_HUMAN_PASSWORD в .env
  Gitea        http://localhost:13000/platform/internal-tools
  Гейтвей      http://localhost:18080/v1/registry

Дальше — человеку:
  1. Войти на главной и сменить временный пароль, который попросит IdP.
  2. Задать пароль учётной записи Gitea (ей одобряются PR в main):
       docker compose exec -u git gitea gitea admin user change-password --username ${GITEA_HUMAN_USER:-<логин>} --password '<ваш пароль>'

Дальше — агенту (правила в AGENTS.md, там же границы: что можно и чего нельзя):
  3. Подключить MCP-сервер платформы: конфиги уже в репозитории (.mcp.json, .cursor/mcp.json, opencode.json),
     команда для любого хоста — bin/sandbox-mcp platform.
  4. list_sources — какие источники одобрены; scaffold_tool — скелет тула; deploy_preview — ссылка человеку;
     open_pull_request — PR, который человек одобряет и мержит.

Проверить, что всё работает по-настоящему:
  make demo-gateway        скоуп, инъекции, двухшаговая запись, аудит
  make demo-identity       вход, подписанная личность, личные ключи MCP
  make demo-data-rights    чувствительные поля по группам и фильтр строк
  make check               контракт допуска и типы — то же, что в CI
TEXT
