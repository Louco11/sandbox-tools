#!/bin/sh
# Рабочая копия песочницы на другом устройстве, подключённая к стенду в локальной сети (сервер — после make lan).
# Агент здесь пишет тул, а выкатывается он на сервере: пуш в Gitea сервера → CI → деплоер → превью.
# Второй стенд тут не поднимается: Docker не нужен, make up и прочие команды стенда откажут.
#
#   GITEA_AGENT_PASSWORD=… sh infra/remote.sh <host> [domain] [каталог]
#   SANDBOX_BRANCH=<ветка> — рабочая копия от другой ветки (по умолчанию main)
#
# Команду целиком печатает `make lan` на сервере. В .env рабочей копии — только адрес стенда и учётка агента
# в Gitea: ни админских учёток, ни токенов гейтвея, ни паролей БД на это устройство не попадает.
set -eu

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
say() { printf '→ %s\n' "$*"; }

HOST=${1:-}
[ -n "$HOST" ] || die "укажите адрес стенда: sh remote.sh 192.168.1.10"
DOMAIN=${2:-tools.$HOST.sslip.io}
TARGET=${3:-$HOME/Projects/Sandbox}
USER_=${GITEA_AGENT_USER:-sandbox-agent}
PASS=${GITEA_AGENT_PASSWORD:-}
[ -n "$PASS" ] || die "нужен GITEA_AGENT_PASSWORD — его печатает make lan на сервере"

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
AUTH=$(printf '%s:%s' "$USER_" "$PASS" | base64 | tr -d '\n')
curl -fsS -m 5 -o /dev/null -H "Authorization: Basic $AUTH" "http://$HOST:13000/api/v1/user" || die "Gitea не приняла учётку $USER_"
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
GITEA_AGENT_USER=$USER_
GITEA_AGENT_PASSWORD=$PASS
EOF
umask 022

say "зависимости"
npm install --no-audit --no-fund --loglevel=error
node --disable-warning=ExperimentalWarning infra/agents/sync.ts >/dev/null

cat <<EOF

Рабочая копия готова: $TARGET → стенд $HOST.
Откройте каталог в Claude Code, Cursor или OpenCode: MCP-сервер sandbox уже настроен.
Агент пройдёт scaffold_tool → validate_manifest → коммит → deploy_preview, превью — http://<тул>--preview.$DOMAIN:18000.
PR одобряете вы в Gitea: http://$HOST:13000/platform/internal-tools/pulls
EOF
