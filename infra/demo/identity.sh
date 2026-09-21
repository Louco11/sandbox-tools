#!/bin/sh
# Демо личности (шаг Б1): до тула доходит только тот, кто вошёл в IdP, и только с личностью, выданной ему.
# Пароли людей здесь не нужны: проверяем то, что должно работать без входа, и подписываем тестовые личности
# ключом самого сервиса identity.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

DOMAIN=${SANDBOX_DOMAIN:-tools.localhost}
J='Content-Type: application/json'
TOOL=${TOOL:-manager-board}
OTHER=${OTHER:-whiteboard}
GW=http://localhost:18080

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
code() { curl -s -o /tmp/sandbox-identity-demo.out -w '%{http_code}' "$@"; }
body() { head -c 120 /tmp/sandbox-identity-demo.out; }
# Личность и сессию подписываем внутри контейнера identity: ключ подписи наружу не выходит.
mint() { docker compose exec -T identity node infra/identity/src/mint.ts "$@" 2>/dev/null | tail -1; }
session() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" sandbox-session 10m mcp 2>/dev/null | tail -1; }

# Демо разбирает личность и доступ на живом туле. На чистом стенде тулов нет: скажем это прямо,
# а не 404 из гейтвея.
need_tool() {
  curl -s "$GW/v1/admin/tools" -H "Authorization: Bearer $GATEWAY_PORTAL_TOKEN" \
    | grep -q "\"name\":\"$1\"" && return 0
  printf '\033[31m✗ на стенде нет тула «%s»\033[0m\n' "$1" >&2
  printf '  создайте тул агентом (MCP «sandbox» → scaffold_tool, deploy_preview) и запустите так:\n' >&2
  printf '    TOOL=<ваш тул> %s\n' "$0" >&2
  exit 1
}
need_tool "$TOOL"
need_tool "$OTHER"

# Тул открыт только владельцу (шаг Б4): чтобы проверять подпись личности, а не доступ, открываем его демо-человеку.
curl -s -X PUT "$GW/v1/admin/tools/$TOOL/access" -H "$J" -H "Authorization: Bearer $GATEWAY_PORTAL_TOKEN" \
  -H "X-Sandbox-Identity: $(docker compose exec -T identity node infra/identity/src/mint.ts "${GITEA_HUMAN_USER:-doronec}" portal 5m web sandbox-admins 2>/dev/null | tail -1)" \
  -d '{"people":["anna.smirnova"]}' >/dev/null

step "1. Без входа до тула и главной не дойти"
printf '  тул, браузер     → %s (вход: %s)\n' "$(code -H 'Accept: text/html' "http://$TOOL.$DOMAIN:18000/")" "$(curl -s -o /dev/null -w '%{redirect_url}' -H 'Accept: text/html' "http://$TOOL.$DOMAIN:18000/" | cut -c1-45)…"
printf '  действие тула    → %s %s\n' "$(code -X POST -H 'Content-Type: application/json' -d '{}' "http://$TOOL.$DOMAIN:18000/api/actions/board")" "$(body)"
printf '  главная          → %s\n' "$(code -H 'Accept: text/html' "http://$DOMAIN:18000/")"

step "2. Свой X-Sandbox-Identity клиенту не помогает: Traefik его вырезает"
FAKE=$(mint anna.smirnova "$TOOL" 30m)
printf '  тул с чужим заголовком → %s (всё равно на вход)\n' "$(code -H 'Accept: text/html' -H "X-Sandbox-Identity: $FAKE" "http://$TOOL.$DOMAIN:18000/")"

step "3. Гейтвей проверяет личность сам"
SECRET=$(docker inspect "tool-$TOOL" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^TOOL_CLIENT_SECRET=' | cut -d= -f2)
TOKEN=$(curl -s -X POST $GW/v1/token -H 'Content-Type: application/json' -d "{\"tool\":\"$TOOL\",\"client_secret\":\"$SECRET\"}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
q() { code -X POST $GW/v1/sources/tasks-readonly/query -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" "$@" -d '{"dataset":"tasks","fields":["id","title"],"limit":1}'; }
printf '  личность этого тула      → %s\n' "$(q -H "X-Sandbox-Identity: $(mint anna.smirnova "$TOOL")")"
printf '  личность другого тула    → %s %s\n' "$(q -H "X-Sandbox-Identity: $(mint anna.smirnova "$OTHER")")" "$(body | tr -d '\\' | sed -n 's/.*"message":"\([^"]*\)".*/\1/p' | cut -c1-60)"
printf '  просроченная личность    → %s\n' "$(q -H "X-Sandbox-Identity: $(mint anna.smirnova "$TOOL" -1m)")"
printf '  подпись alg=none         → %s\n' "$(q -H 'X-Sandbox-Identity: eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbm5hLnNtaXJub3ZhIn0.')"

step "4. Агент тоже входит: X-Actor больше не личность"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}'
printf '  тул /mcp с X-Actor       → %s (заголовок больше ничего не значит)\n' "$(code -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H 'X-Actor: anna.smirnova' -d "$INIT" "http://$TOOL.$DOMAIN:18000/mcp")"
printf '  тул /mcp после входа     → %s\n' "$(code -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $(session anna.smirnova)" -d "$INIT" "http://$TOOL.$DOMAIN:18000/mcp")"
printf '  гейтвей с X-Actor        → %s\n' "$(q -H 'X-Actor: anna.smirnova')"
DEV=$(curl -s -X POST "http://id.$DOMAIN:18000/device/start")
printf '  вход агента (device flow): код %s, ссылка %s\n' "$(printf '%s' "$DEV" | sed -n 's/.*"user_code":"\([^"]*\)".*/\1/p')" "$(printf '%s' "$DEV" | sed -n 's/.*"verification_url":"\([^"]*\)".*/\1/p' | cut -c1-58)…"

step "5. Личный ключ MCP: выпуск, работа, отзыв"
S=$(docker compose exec -T identity node infra/identity/src/mint.ts ivan.petrov sandbox-session 5m web 2>/dev/null | tail -1)
ISSUED=$(curl -s -X POST "http://id.$DOMAIN:18000/keys" -H "Authorization: Bearer $S" -H "$J" -d '{"name":"демо"}')
KEY=$(printf '%s' "$ISSUED" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')
PREFIX=$(printf '%s' "$ISSUED" | sed -n 's/.*"prefix":"\([^"]*\)".*/\1/p')
mcpkey() { code -X POST -H "$J" -H 'Accept: application/json, text/event-stream' -H "Authorization: Bearer $KEY" -d "$INIT" "http://$TOOL.$DOMAIN:18000/mcp"; }
printf '  выпущен ключ sbx_%s_… (секрет показан один раз)\n' "$PREFIX"
printf '  тул /mcp с ключом        → %s\n' "$(mcpkey)"
curl -s -X DELETE "http://id.$DOMAIN:18000/keys/$PREFIX?reason=demo" -H "Authorization: Bearer $S" >/dev/null
printf '  после отзыва             → %s (сразу, без ожидания)\n' "$(mcpkey)"
printf '  ключ из агента не выписать → %s\n' "$(code -X POST "http://id.$DOMAIN:18000/keys" -H "$J" -H "Authorization: Bearer $(session ivan.petrov)" -d '{"name":"из агента"}')"
printf '  в базе только префикс и хэш: %s\n' "$(docker compose exec -T postgres psql -U sources_admin -d sources -qAt -c "select 'секрета нет: ' || count(*) from identity.keys where secret_hash like 'sbx_%'" 2>/dev/null)"

step "6. Вход человека"
printf '  IdP:       http://auth.%s:18000/realms/sandbox/account\n' "$DOMAIN"
printf '  песочница: http://%s:18000 — вход спросит IdP\n' "$DOMAIN"
curl -s -X PUT "$GW/v1/admin/tools/$TOOL/access" -H "$J" -H "Authorization: Bearer $GATEWAY_PORTAL_TOKEN" \
  -H "X-Sandbox-Identity: $(docker compose exec -T identity node infra/identity/src/mint.ts "${GITEA_HUMAN_USER:-doronec}" portal 5m web sandbox-admins 2>/dev/null | tail -1)" \
  -d '{"people":[]}' >/dev/null   # вернули как было: тул снова только для владельца
printf '  агент:     bin/sandbox-mcp login — браузер подтвердит вход, ключ ляжет в Keychain; конфиги — в кабинете /me\n'
printf '  пароли стенда лежат в .env: KEYCLOAK_HUMAN_PASSWORD (временный, сменить при входе), KEYCLOAK_DEMO_PASSWORD\n'
