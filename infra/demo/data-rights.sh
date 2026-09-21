#!/bin/sh
# Демо прав на данные (шаг Б5): что человек видит внутри тула и что ему разрешено менять.
# Тул один и тот же, люди разные — отличаются поля, строки и доступные права записи.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

GW=http://localhost:18080
J='Content-Type: application/json'
ADMIN="Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
P="Authorization: Bearer $GATEWAY_PORTAL_TOKEN"
TOOL=demo-rights-$(date +%H%M%S)      # свой инстанс на прогон: чужие тулы не трогаем
BUYER=${BUYER:-maria.volkova}         # закупки: видит контакты
CLERK=${CLERK:-anna.smirnova}         # без групп: контакты не видит

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
id() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" "$2" 5m web "${3:-}" 2>/dev/null | tail -1; }
sql() { docker compose exec -T postgres psql -U sources_admin -d sources -qAt -c "$1"; }
ADMIN_ID=$(id "${GITEA_HUMAN_USER:-doronec}" portal sandbox-admins)
group() { curl -s -X POST "$GW/v1/admin/groups" -H "$P" -H "$J" -H "X-Sandbox-Identity: $ADMIN_ID" -d "{\"name\":\"$1\",\"title\":\"$2\"}" >/dev/null; }
member() { curl -s -X POST "$GW/v1/admin/groups/$1/members" -H "$P" -H "$J" -H "X-Sandbox-Identity: $ADMIN_ID" -d "{\"login\":\"$2\"}" >/dev/null; }

step "1. Готовим группы закупок и тул с правом записи только для них"
group procurement "Закупки" ; group procurement-region "Закупки — регионы"
member procurement "$BUYER"          # закупки целиком: видят контакты и всех поставщиков
member procurement-region "$CLERK"   # регионы: свои города, контакты не видят
SECRET=$(curl -sf -X POST $GW/v1/admin/tools -H "$J" -H "$ADMIN" -d "{\"manifest\":{
  \"name\":\"$TOOL\",\"owner\":\"${GITEA_HUMAN_USER:-doronec}\",\"ttl_days\":1,
  \"sources\":[\"suppliers-readonly\"],
  \"writes\":[{\"suppliers.offer:set_price\":{\"groups\":[\"procurement\"]}}],
  \"ui\":{\"mode\":[\"web\"]},\"access\":{\"groups\":[\"procurement\"],\"people\":[\"$CLERK\"]}}}" | sed -n 's/.*"client_secret":"\([^"]*\)".*/\1/p')
TOKEN=$(curl -sf -X POST $GW/v1/token -H "$J" -d "{\"tool\":\"$TOOL\",\"client_secret\":\"$SECRET\"}" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
AUTH="Authorization: Bearer $TOKEN"
echo "  тул $TOOL: источник поставщиков, цена — только группе procurement"

q() { curl -s -X POST "$GW/v1/sources/suppliers-readonly/query" -H "$J" -H "$AUTH" -H "X-Sandbox-Identity: $(id "$1" "$TOOL")" \
  -d '{"dataset":"suppliers","fields":["id","name","city","contact","phone"],"order_by":{"field":"id"},"limit":3}'; }

step "2. Чувствительные поля: контакт и телефон видят только закупки"
printf '  %-15s %s\n' "$BUYER" "$(q "$BUYER" | python3 -c "import json,sys;d=json.load(sys.stdin);r=d['rows'][0];print('строк', d['row_count'], '| контакт:', r['contact'], '| скрыто:', d.get('redacted', 'ничего'))")"
printf '  %-15s %s\n' "$CLERK" "$(q "$CLERK" | python3 -c "import json,sys;d=json.load(sys.stdin);r=(d['rows'] or [{}])[0];print('строк', d['row_count'], '| контакт:', r.get('contact'), '| скрыто:', ', '.join(d.get('redacted', [])))")"

step "3. Фильтр строк: у закупок по городам свои поставщики"
printf '  %-15s %s\n' "$BUYER" "$(q "$BUYER" | python3 -c "import json,sys;d=json.load(sys.stdin);print('города:', sorted({r['city'] for r in d['rows']}), '| охват:', d.get('row_scope','весь набор'))")"
printf '  %-15s %s\n' "$CLERK" "$(q "$CLERK" | python3 -c "import json,sys;d=json.load(sys.stdin);print('города:', sorted({r['city'] for r in d['rows']}), '| охват:', d.get('row_scope','весь набор'))")"

step "4. Право записи по группам: цену меняют только закупки"
w() { curl -s -o /tmp/sandbox-rights.json -w '%{http_code}' -X POST "$GW/v1/writes/suppliers.offer:set_price/apply" -H "$J" -H "$AUTH" \
  -H "X-Sandbox-Identity: $(id "$1" "$TOOL")" -d '{"params":{"offer_id":1,"price":100}}'; }
printf '  %-15s → %s %s\n' "$BUYER" "$(w "$BUYER")" "$(sed -n 's/.*"summary":"\([^"]*\)".*/\1/p' /tmp/sandbox-rights.json | cut -c1-60)"
printf '  %-15s → %s %s\n' "$CLERK" "$(w "$CLERK")" "$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' /tmp/sandbox-rights.json | cut -c1-70)"

step "5. Что видно в аудите"
sql "select actor || ' — ' || operation || ' — ' || coalesce(left(reason, 60), 'ок') from audit.calls where tool = '$TOOL' order by id desc limit 5" | sed 's/^/  /'

step "6. Уборка"
curl -s -X POST "$GW/v1/admin/tools/$TOOL/revoke" -H "$J" -H "$ADMIN" -d '{"reason":"демо"}' >/dev/null
sql "DELETE FROM gateway.tools WHERE name = '$TOOL'" >/dev/null
for g in procurement procurement-region; do
  curl -s -X DELETE "$GW/v1/admin/groups/$g" -H "$P" -H "X-Sandbox-Identity: $ADMIN_ID" >/dev/null
done
echo "  демо-тул и группы убраны; правила остались в реестре — это решение хранителя данных"
