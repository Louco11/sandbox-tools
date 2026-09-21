#!/bin/sh
# Демо шага Б6: у каждого человека свой агент в репозитории.
#
# Раньше все агенты пушили под общей учёткой sandbox-agent, а её пароль лежал в .env на машине разработчика.
# Теперь агент приходит с личным ключом своего человека, сервис личности проверяет группу sandbox-developers
# и выдаёт короткоживущий токен бота <логин>-agent. Пароль администратора Gitea остаётся на сервере.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

DOMAIN=${SANDBOX_DOMAIN:-tools.localhost}
ID="http://id.$DOMAIN:18000"
GITEA=http://localhost:13000
DEV=${DEV:-${GITEA_HUMAN_USER:-doronec}}   # человек с группой sandbox-developers
OUT=${OUT:-anna.smirnova}                  # человек без неё
ADMIN="$GITEA_ADMIN_USER:$GITEA_ADMIN_PASSWORD"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
line() { printf '  %-42s %s\n' "$1" "$2"; }
sess() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" sandbox-session 10m web 2>/dev/null | tail -1; }
key_for() {  # выпускаем человеку ключ так же, как он сделал бы это в кабинете /me
  curl -s -X POST "$ID/keys" -H 'Content-Type: application/json' -H "Cookie: sandbox_session=$(sess "$1")" \
    -d '{"name":"демо Б6"}' | sed -n 's/.*"key":"\([^"]*\)".*/\1/p'
}
forge() { curl -s -o /tmp/sandbox-forge.json -w '%{http_code}' -X POST "$ID/forge/token" -H "Authorization: Bearer $1"; }
field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p" /tmp/sandbox-forge.json; }

step "1. Без ключа доступа к репозиторию нет"
line "POST /forge/token без ключа" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ID/forge/token")"

step "2. Ключ есть, группы sandbox-developers нет"
OUT_KEY=$(key_for "$OUT")
CODE=$(forge "$OUT_KEY")
line "$OUT" "$CODE"
printf '  %s\n' "$(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' /tmp/sandbox-forge.json)"

step "3. Разработчик получает токен своего агента"
DEV_KEY=$(key_for "$DEV")
CODE=$(forge "$DEV_KEY")
BOT=$(field user)
TOKEN=$(field token)
line "$DEV" "$CODE, агент $BOT"
line "токен живёт" "$(field expires_at | cut -c1-16) (часы, не вечно)"

step "4. Агент пушит ветку от имени своего человека"
BRANCH="demo/forge-$(date +%H%M%S)"
AUTH=$(printf '%s:%s' "$BOT" "$TOKEN" | base64 | tr -d '\n')
git -c credential.helper= -c http.extraHeader="Authorization: Basic $AUTH" \
  push -q "$GITEA/platform/internal-tools.git" "HEAD:refs/heads/$BRANCH" 2>/dev/null \
  && line "push $BRANCH" "ок" || line "push $BRANCH" "не прошёл"
line "кто это сделал" "$BOT — видно в истории репозитория"

step "5. В main агент не пишет — это защита ветки, а не доверие"
# Спрашиваем Gitea от имени бота: может ли он писать в main. Пробный пуш в main здесь не делаем —
# если бы защита вдруг не работала, демо само испортило бы main.
MAIN=$(curl -s -u "$BOT:$TOKEN" "$GITEA/api/v1/repos/platform/internal-tools/branches/main")
line "ветка main защищена" "$(printf '%s' "$MAIN" | sed -n 's/.*"protected":\([a-z]*\).*/\1/p')"
line "агент может писать в main" "$(printf '%s' "$MAIN" | sed -n 's/.*"user_can_push":\([a-z]*\).*/\1/p')"
line "путь в прод" "ветка → CI → превью → PR → человек"

step "6. Отзыв ключей обрывает и доступ агента"
# Причина — латиницей: кириллица в строке запроса не проходит через Traefik.
REVOKED=$(curl -s -X DELETE "$ID/keys/all?reason=demo" -H "Cookie: sandbox_session=$(sess "$DEV")" | sed -n 's/.*"revoked":\([0-9]*\).*/\1/p')
line "отозвано ключей человека" "${REVOKED:-0}"
# Токен бота проверяем там, где у него есть права: репозиторий. Удалённый токен — уже не аутентификация.
CODE=$(curl -s -o /dev/null -w '%{http_code}' -u "$BOT:$TOKEN" "$GITEA/api/v1/repos/platform/internal-tools")
line "прежний токен агента" "$CODE (401 — удалён вместе с ключами)"
line "ключ человека" "$(forge "$DEV_KEY") (401 — ключ отозван)"

step "Уборка"
curl -s -o /dev/null -u "$ADMIN" -X DELETE "$GITEA/api/v1/repos/platform/internal-tools/branches/$BRANCH"
line "ветка $BRANCH" "удалена"
printf '\n\033[1mИтог:\033[0m пароля учётной записи на машине разработчика нет — только личный ключ человека,\n'
printf 'а в истории репозитория видно, чей агент что сделал.\n'
