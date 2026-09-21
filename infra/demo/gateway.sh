#!/bin/sh
# Демо гейтвея: контракт допуска, скоуп, двухшаговая запись, MCP, аудит.
# Всё через HTTP, как это делали бы CI, тул и агент.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

GW=http://localhost:18080
ADMIN="Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
J='Content-Type: application/json'

# Личность человека для демо: подписываем ключом самого identity (нужен доступ к стенду, наружу этого нет).
mint() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" "$2" "${3:-5m}" "${4:-web}" 2>/dev/null | tail -1; }
# Тул по умолчанию открыт только владельцу (шаг Б4) — демо открывает свои тулы человеку, от лица которого идёт.
open_to() {
  curl -s -X PUT "$GW/v1/admin/tools/$1/access" -H "$J" -H "Authorization: Bearer $GATEWAY_PORTAL_TOKEN" \
    -H "X-Sandbox-Identity: $(mint "${GITEA_HUMAN_USER:-doronec}" portal 5m web sandbox-admins)" \
    -d "{\"people\":[\"$2\"]}" >/dev/null
}

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
call() { # метод url [данные] [заголовки...] — печатает HTTP-код и тело
  m=$1 u=$2 d=${3:-}; shift 2; [ $# -gt 0 ] && shift
  curl -s -w '\n  HTTP %{http_code}\n' -X "$m" "$GW$u" -H "$J" "$@" ${d:+-d "$d"}
}

step "1. CI регистрирует тул с неодобренным источником → 422"
call POST /v1/admin/tools '{"manifest":{"name":"demo-hr","owner":"ivan.petrov","ttl_days":30,"sources":["hr-salaries"],"ui":{"mode":["web"]}}}' -H "$ADMIN" | jq -r '.errors[]?.message // .' 2>/dev/null || true

step "2. CI регистрирует тул demo-kb-lookup (только knowledge-readonly) → 201"
SECRET=$(curl -sf -X POST $GW/v1/admin/tools -H "$J" -H "$ADMIN" \
  -d '{"manifest":{"name":"demo-kb-lookup","owner":"ivan.petrov","ttl_days":30,"sources":["knowledge-readonly"],"ui":{"mode":["web"]}}}' | jq -r .client_secret)
echo "  секрет выдан: ${SECRET%"${SECRET#????????}"}…"

step "3. Тул обменивает секрет на короткий токен"
TOKEN_JSON=$(curl -sf -X POST $GW/v1/token -H "$J" -d "{\"tool\":\"demo-kb-lookup\",\"client_secret\":\"$SECRET\"}")
TOKEN=$(printf '%s' "$TOKEN_JSON" | jq -r .access_token)
echo "  токен получен, живёт $(printf '%s' "$TOKEN_JSON" | jq .expires_in) с"
AUTH="Authorization: Bearer $TOKEN"
open_to demo-kb-lookup anna.smirnova
HUMAN="X-Sandbox-Identity: $(mint anna.smirnova demo-kb-lookup 10m)"

step "4. Чтение из своего источника → 200"
curl -sf -X POST $GW/v1/sources/knowledge-readonly/query -H "$J" -H "$AUTH" -H "$HUMAN" \
  -d '{"dataset":"notes","fields":["id","kind","title","tags"],"where":[{"field":"kind","op":"eq","value":"decision"}],"limit":3}' \
  | jq -c '.rows[]'

step "5. Чтение из чужого источника (tasks-readonly) → 403"
call POST /v1/sources/tasks-readonly/query '{"dataset":"tasks","limit":1}' -H "$AUTH" -H "$HUMAN"

step "6. Попытка SQL-инъекции через имя поля → 400, в SQL не попадает"
call POST /v1/sources/knowledge-readonly/query '{"dataset":"notes","fields":["id\"; drop table knowledge.notes; --"]}' -H "$AUTH" -H "$HUMAN"

step "7. Запись, не объявленная в манифесте → 403"
call POST '/v1/writes/knowledge.note:create/prepare' '{"params":{"kind":"note","title":"x","body":"x"}}' -H "$AUTH" -H "$HUMAN"

step "8. Без личности человека → 401"
call POST /v1/sources/knowledge-readonly/query '{"dataset":"notes","limit":1}' -H "$AUTH"

step "9. Тул с правом записи: demo-board (tasks-readonly + tasks.task:update)"
SECRET2=$(curl -sf -X POST $GW/v1/admin/tools -H "$J" -H "$ADMIN" \
  -d '{"manifest":{"name":"demo-board","owner":"ivan.petrov","ttl_days":30,"sources":["tasks-readonly"],"writes":["tasks.task:update"],"ui":{"mode":["web","mcp-app"]}}}' | jq -r .client_secret)
TOKEN2=$(curl -sf -X POST $GW/v1/token -H "$J" -d "{\"tool\":\"demo-board\",\"client_secret\":\"$SECRET2\"}" | jq -r .access_token)
AUTH2="Authorization: Bearer $TOKEN2"
open_to demo-board anna.smirnova
# Две личности одного человека: из браузера (канал web) и из хоста агента (канал mcp) — канал решает, можно ли
# подтверждать запись самому.
HUMAN2="X-Sandbox-Identity: $(mint anna.smirnova demo-board 10m web)"
AGENT2="X-Sandbox-Identity: $(mint anna.smirnova demo-board 10m mcp)"
TASK=$(curl -sf -X POST $GW/v1/sources/tasks-readonly/query -H "$J" -H "$AUTH2" -H "$HUMAN2" \
  -d '{"dataset":"tasks","fields":["id","title"],"where":[{"field":"status","op":"eq","value":"todo"}],"order_by":{"field":"id"},"limit":1}' | jq '.rows[0].id')
echo "  первая задача в колонке «К работе»: #$TASK"

step "10. Агент через MCP: list_sources и prepare_write (данные не меняются)"
MCP_H='Accept: application/json, text/event-stream'
mcp() { curl -s -X POST $GW/mcp -H "$J" -H "$MCP_H" -H "$AUTH2" -H "$AGENT2" -H 'X-Agent: board-assistant' -d "$1" | sed -n 's/^data: //p'; }
mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -r '"  инструменты агента: " + ([.result.tools[].name] | join(", "))'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sources","arguments":{}}}' \
  | jq -r '.result.content[0].text | fromjson | .sources[] | "  \(.id): in_scope=\(.in_scope)"'
CONF=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"prepare_write\",\"arguments\":{\"write\":\"tasks.task:update\",\"params\":{\"task_id\":$TASK,\"status\":\"in_progress\"}}}}" \
  | jq -r '.result.content[0].text | fromjson | "\(.confirmation_id)|\(.summary)"')
echo "  подготовлено: ${CONF#*|}"
CONF_ID=${CONF%%|*}

step "11. Агент пытается подтвердить без согласия человека (канал mcp, без approval) → 400"
call POST "/v1/writes/confirmations/$CONF_ID/commit" '' -H "$AUTH2" -H "$AGENT2" -H 'X-Agent: board-assistant'

step "12. Человек подтверждает из интерфейса (канал web) → 200"
call POST "/v1/writes/confirmations/$CONF_ID/commit" '' -H "$AUTH2" -H "$HUMAN2"

step "13. Повторное подтверждение того же → 404"
call POST "/v1/writes/confirmations/$CONF_ID/commit" '' -H "$AUTH2" -H "$HUMAN2"

step "14. Передеплой тула инвалидирует старый токен → 401"
curl -sf -X POST $GW/v1/admin/tools -H "$J" -H "$ADMIN" \
  -d '{"manifest":{"name":"demo-kb-lookup","owner":"ivan.petrov","ttl_days":30,"sources":["knowledge-readonly"],"ui":{"mode":["web"]}}}' >/dev/null
call POST /v1/sources/knowledge-readonly/query '{"dataset":"notes","limit":1}' -H "$AUTH" -H "$HUMAN"

step "15. Аудит: последние записи"
docker compose exec -T postgres psql -U sources_admin -d sources -c \
  "select id, actor, tool, source, operation, agent_in_chain as agent, allowed, left(coalesce(reason,''), 60) as reason
     from audit.calls order by id desc limit 18;"

step "Уборка: демо-тулы убираем за собой"
for t in demo-kb-lookup demo-board; do
  curl -s -X POST "$GW/v1/admin/tools/$t/revoke" -H "$J" -H "$ADMIN" -d '{"reason":"демо"}' >/dev/null
  docker compose exec -T postgres psql -U sources_admin -d sources -qAt \
    -c "DELETE FROM gateway.pending_writes WHERE tool = '$t'; DELETE FROM gateway.tool_access WHERE tool = '$t'; DELETE FROM gateway.tools WHERE name = '$t'" >/dev/null
  echo "  $t убран"
done

