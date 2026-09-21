#!/bin/sh
# Рабочая копия песочницы на другом устройстве, подключённая к стенду в локальной сети (сервер — после make lan).
# Агент здесь пишет тул, а выкатывается он на сервере: пуш в Gitea сервера → CI → деплоер → превью.
# Второй стенд тут не поднимается: Docker не нужен, make up и прочие команды стенда откажут.
#
#   SANDBOX_MCP_KEY=sbx_… sh infra/remote.sh <host> [domain] [каталог]
#   SANDBOX_BRANCH=<ветка> — рабочая копия от другой ветки (по умолчанию main)
#
# Команду целиком печатает `make lan` на сервере. Ключ — личный, человека: его выдаёт кабинет `/me` на главной
# (шаг Б2). В .env рабочей копии остаётся только адрес стенда: ни паролей учётных записей, ни токенов гейтвея,
# ни паролей БД на это устройство не попадает (шаг Б6).
set -eu

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
say() { printf '→ %s\n' "$*"; }

HOST=${1:-}
[ -n "$HOST" ] || die "укажите адрес стенда: sh remote.sh 192.168.1.10"
DOMAIN=${2:-tools.$HOST.sslip.io}
TARGET=${3:-$HOME/Projects/Sandbox}
KEY=${SANDBOX_MCP_KEY:-}
[ -n "$KEY" ] || die "нужен личный ключ MCP: SANDBOX_MCP_KEY=sbx_… — выпишите его в кабинете http://$DOMAIN:18000/me"

say "окружение"
for cmd in git node npm curl; do command -v "$cmd" >/dev/null 2>&1 || die "нет $cmd"; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "нужен Node ≥ 22.18, сейчас $(node -v)"
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then die "каталог $TARGET не пуст"; fi

say "стенд $HOST"
check() { curl -fsS -m 5 -o /dev/null "$2" 2>/dev/null || die "$1 недоступен: $2 — на сервере выполнен make lan HOST=$HOST?"; }
check Gitea "http://$HOST:13000/api/healthz"
check гейтвей "http://$HOST:18080/v1/registry"
check деплоер "http://$HOST:18090/healthz"
# Ключ человека меняем на короткоживущий токен его агента: пароли учётных записей сюда не приезжают.
FORGE=$(curl -fsS -m 10 -X POST -H "Authorization: Bearer $KEY" "http://id.$DOMAIN:18000/forge/token" 2>/dev/null) \
  || die "сервис личности не выдал доступ агенту. Ключ верный? Состоите в группе sandbox-developers?"
USER_=$(printf '%s' "$FORGE" | sed -n 's/.*"user":"\([^"]*\)".*/\1/p')
TOKEN=$(printf '%s' "$FORGE" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$USER_" ] && [ -n "$TOKEN" ] || die "сервис личности вернул неожиданный ответ"
AUTH=$(printf '%s:%s' "$USER_" "$TOKEN" | base64 | tr -d '\n')
say "агент $USER_ (от вашего имени)"
if ! curl -fsS -m 5 -o /dev/null "http://$DOMAIN:18000/healthz"; then
  echo "! http://$DOMAIN:18000 не открывается: имена тулов не резолвятся с этого устройства."
  echo "  Код писать и выкатывать можно; превью в браузере — через свой DNS или SSH-туннель (README)."
fi

say "клон репозитория (учётка в .git/config не сохраняется)"
BRANCH=${SANDBOX_BRANCH:-main}
git -c credential.helper= -c http.extraHeader="Authorization: Basic $AUTH" clone -q --branch "$BRANCH" "http://$HOST:13000/platform/internal-tools.git" "$TARGET"
cd "$TARGET"
git remote rename origin gitea
# Без защиты в Makefile `make up` здесь поднял бы второй стенд под тем же именем проекта compose.
if ! grep -q '^stand:' Makefile; then
  cd / && rm -rf "$TARGET"
  die "в $BRANCH нет защиты удалённой рабочей копии (цель stand в Makefile) — обновите платформу на сервере"
fi

umask 077
cat > .env <<EOF
# Рабочая копия, подключённая к стенду $HOST (infra/remote.sh). Стенда на этом устройстве нет.
SANDBOX_REMOTE=1
SANDBOX_HOST=$HOST
SANDBOX_DOMAIN=$DOMAIN
EOF
umask 022

say "зависимости"
npm install --no-audit --no-fund --loglevel=error
node --disable-warning=ExperimentalWarning infra/agents/sync.ts >/dev/null

cat <<EOF

Рабочая копия готова: $TARGET → стенд $HOST.
Откройте каталог в Claude Code, Cursor или OpenCode: MCP-сервер sandbox уже настроен.
Один раз выполните bin/sandbox-mcp login — ключ ляжет в Keychain, и агент будет работать от вашего имени.
Агент пройдёт scaffold_tool → validate_manifest → коммит → deploy_preview, превью — http://<тул>--preview.$DOMAIN:18000.
PR одобряете вы в Gitea: http://$HOST:13000/platform/internal-tools/pulls
EOF
