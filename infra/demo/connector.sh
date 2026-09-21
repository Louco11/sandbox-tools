#!/bin/sh
# Демо коннектора: второй источник («Поставщики») подключён записью в реестре и сервисом за гейтвеем,
# без строки в gateway/. Чтение, запись сразу (человек в UI), важная запись с подтверждением, агент с согласием,
# изоляция коннектора, реестр без перезапуска гейтвея. Всё через HTTP, как это делали бы тул и агент.
#   make demo-connector
# Демо меняет данные коннектора (цена, новый поставщик, архив) — они в томе suppliers-data.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

GW=http://localhost:18080
J='Content-Type: application/json'
ADMIN="Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
TOOL=demo-sup-$(date +%H%M%S)   # своё имя на запуск: отозванный тул обратно не допускается
# Две личности одного человека: из браузера (web) и из хоста агента (mcp) — канал решает, кто подтверждает запись.
mint() { docker compose exec -T identity node infra/identity/src/mint.ts anna.smirnova "$TOOL" 15m "$1" procurement 2>/dev/null | tail -1; }
# У источника поставщиков строки фильтруются по городу (шаг Б5): демо работает от закупок, которые видят всех.
HUMAN="X-Sandbox-Identity: $(mint web)"
AGENT="X-Sandbox-Identity: $(mint mcp)"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
must() { # описание ожидаемое фактическое
  if [ "$2" = "$3" ]; then echo "  ✓ $1"; else echo "  ✗ $1: ожидалось $2, получено $3"; exit 1; fi
}

START=$(date -u +%Y-%m-%dT%H:%M:%SZ)

step "1. Тул с источником-коннектором проходит допуск"
SECRET=$(curl -sf -X POST $GW/v1/admin/tools -H "$J" -H "$ADMIN" -d "{\"manifest\":{\"name\":\"$TOOL\",\"owner\":\"anna.smirnova\",\"ttl_days\":1,
  \"sources\":[\"suppliers-readonly\"],\"writes\":[\"suppliers.offer:set_price\",\"suppliers.supplier:create\",\"suppliers.supplier:archive\"],
  \"ui\":{\"mode\":[\"web\"]}}}" | jq -r .client_secret)
TOKEN=$(curl -sf -X POST $GW/v1/token -H "$J" -d "{\"tool\":\"$TOOL\",\"client_secret\":\"$SECRET\"}" | jq -r .access_token)
AUTH="Authorization: Bearer $TOKEN"
q() { curl -s -X POST "$GW/v1/sources/suppliers-readonly/query" -H "$J" -H "$AUTH" -H "$HUMAN" -d "$1"; }
archived() { q "{\"dataset\":\"suppliers\",\"fields\":[\"archived\"],\"where\":[{\"field\":\"id\",\"op\":\"eq\",\"value\":$1}]}" | jq '.rows[0].archived'; }
echo "  $TOOL допущен"

step "2. Чтение через гейтвей: фильтр, сортировка, только разрешённые поля"
q '{"dataset":"offers","fields":["id","item","price"],"where":[{"field":"price","op":"gt","value":900}],"order_by":{"field":"price","dir":"desc"}}' \
  | jq -r '.rows[] | "  #\(.id) \(.item) — \(.price) ₽"'
must "поле вне реестра — отказ гейтвея, до коннектора не доходит" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/v1/sources/suppliers-readonly/query" -H "$J" -H "$AUTH" -H "$HUMAN" -d '{"dataset":"offers","fields":["secret"]}')"

step "3. Человек в UI меняет цену — пишется сразу, сводку сформулировал коннектор"
PRICE=$(q '{"dataset":"offers","fields":["price"],"where":[{"field":"id","op":"eq","value":1}]}' | jq '.rows[0].price')
NEW=$((PRICE + 10))
curl -s -X POST "$GW/v1/writes/suppliers.offer:set_price/apply" -H "$J" -H "$AUTH" -H "$HUMAN" -d "{\"params\":{\"offer_id\":1,\"price\":$NEW}}" | jq -r '"  \(.summary)"'
must "цена в источнике" "$NEW" "$(q '{"dataset":"offers","fields":["price"],"where":[{"field":"id","op":"eq","value":1}]}' | jq '.rows[0].price')"
must "ошибка источника доходит до человека (цена 0)" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/v1/writes/suppliers.offer:set_price/apply" -H "$J" -H "$AUTH" -H "$HUMAN" -d '{"params":{"offer_id":1,"price":0}}')"

step "4. Важная запись (архив поставщика, confirm) — сначала сводка, запись только после «Подтвердить»"
NAME="Демо-поставщик $(date +%H%M%S)"
SID=$(curl -s -X POST "$GW/v1/writes/suppliers.supplier:create/apply" -H "$J" -H "$AUTH" -H "$HUMAN" -d "{\"params\":{\"name\":\"$NAME\",\"city\":\"Казань\"}}" | jq .supplier_id)
P=$(curl -s -X POST "$GW/v1/writes/suppliers.supplier:archive/apply" -H "$J" -H "$AUTH" -H "$HUMAN" -d "{\"params\":{\"supplier_id\":$SID}}")
echo "  $(printf '%s' "$P" | jq -r .summary)"
must "до подтверждения не в архиве" false "$(archived "$SID")"
curl -s -X POST "$GW/v1/writes/confirmations/$(printf '%s' "$P" | jq -r .confirmation_id)/commit" -H "$J" -H "$AUTH" -H "$HUMAN" -d '{}' >/dev/null
must "после «Подтвердить» в архиве" true "$(archived "$SID")"

step "5. Агент: только подготовка; без согласия человека — отказ"
A=$(curl -s -X POST "$GW/v1/writes/suppliers.offer:set_price/prepare" -H "$J" -H "$AUTH" -H "$AGENT" -H 'X-Agent: demo-agent' -d '{"params":{"offer_id":2,"price":999}}')
echo "  агенту: $(printf '%s' "$A" | jq -r .summary)"
CID=$(printf '%s' "$A" | jq -r .confirmation_id)
must "commit без approval" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/v1/writes/confirmations/$CID/commit" -H "$J" -H "$AUTH" -H "$AGENT" -H 'X-Agent: demo-agent' -d '{}')"
must "commit с согласием «да, меняй»" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/v1/writes/confirmations/$CID/commit" -H "$J" -H "$AUTH" -H "$AGENT" -H 'X-Agent: demo-agent' -d '{"approval":"да, меняй"}')"

step "6. Коннектор изолирован: из сети тулов недоступен, без токена гейтвея отказывает"
from_tools() { docker run --rm --network sandbox_tools node:22-bookworm-slim node -e "fetch('http://connector-suppliers:8080/healthz').then(()=>console.log('reachable'),()=>console.log('unreachable'))"; }
no_token() { docker exec sandbox-gateway-1 node -e "fetch('http://connector-suppliers:8080/query',{method:'POST',body:'{}'}).then(r=>console.log(r.status))"; }
must "из сети тулов" unreachable "$(from_tools)"
must "из гейтвея без токена" 401 "$(no_token)"

step "7. Реестр без перезапуска гейтвея: сломанный не применяется, исправленный — применяется"
cp registry/sources.yaml /tmp/sandbox-registry.bak
trap 'cp /tmp/sandbox-registry.bak registry/sources.yaml' EXIT
printf '\n  broken: [\n' >> registry/sources.yaml
sleep 5
echo "  ошибка: $(curl -s $GW/v1/registry | jq -r '.reload_error' | cut -c1-90)…"
must "гейтвей работает на прежнем реестре" 200 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GW/v1/sources/suppliers-readonly/query" -H "$J" -H "$AUTH" -H "$HUMAN" -d '{"dataset":"offers","limit":1}')"
cp /tmp/sandbox-registry.bak registry/sources.yaml
sed -i.tmp 's/^    title: Поставщики — кто, где и почём поставляет продукты и упаковку (только чтение)$/    title: Поставщики — кто, где и почём поставляет (только чтение)/' registry/sources.yaml && rm -f registry/sources.yaml.tmp
sleep 5
must "новое название источника без перезапуска" "Поставщики — кто, где и почём поставляет (только чтение)" "$(curl -s $GW/v1/registry | jq -r '.sources["suppliers-readonly"].title')"
cp /tmp/sandbox-registry.bak registry/sources.yaml
trap - EXIT

step "8. Аудит: чтение, записи, отказы — как у любого источника"
docker compose exec -T postgres psql -U sources_admin -d sources -c \
  "select actor, operation, source, agent_in_chain as agent, allowed, left(coalesce(reason,''),50) as reason from audit.calls where tool='$TOOL' and at >= '$START' order by id"

curl -s -X POST $GW/v1/admin/tools/$TOOL/revoke -H "$ADMIN" >/dev/null
printf '\n%s отозван.\n' "$TOOL"

step "Уборка: демо-тулы убираем за собой"
for t in "$TOOL"; do
  curl -s -X POST "$GW/v1/admin/tools/$t/revoke" -H "$J" -H "$ADMIN" -d '{"reason":"демо"}' >/dev/null
  docker compose exec -T postgres psql -U sources_admin -d sources -qAt \
    -c "DELETE FROM gateway.pending_writes WHERE tool = '$t'; DELETE FROM gateway.tool_access WHERE tool = '$t'; DELETE FROM gateway.tools WHERE name = '$t'" >/dev/null
  echo "  $t убран"
done

