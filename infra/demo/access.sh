#!/bin/sh
# Демо доступа к тулу (шаг Б4): тул открыт кругу людей, а не всем вошедшим; круг ограничен и со стороны данных.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

GW=http://localhost:18080
DOMAIN=${SANDBOX_DOMAIN:-tools.localhost}
TOOL=${TOOL:-manager-board}
GROUP=${GROUP:-support-team}
INSIDE=${INSIDE:-maria.volkova}     # состоит в группе
OUTSIDE=${OUTSIDE:-anna.smirnova}   # не состоит
P="Authorization: Bearer $GATEWAY_PORTAL_TOKEN"
J='Content-Type: application/json'

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
sess() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" sandbox-session 10m "${2:-web}" 2>/dev/null | tail -1; }
pid() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" portal 5m web 2>/dev/null | tail -1; }
web() { curl -s -o /tmp/sandbox-access-demo.html -w '%{http_code}' -H 'Accept: text/html' -H "Cookie: sandbox_session=$(sess "$1")" "http://$TOOL.$DOMAIN:18000/"; }
mcp() {
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "$J" -H 'Accept: application/json, text/event-stream' \
    -H "Authorization: Bearer $(sess "$1" mcp)" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1"}}}' \
    "http://$TOOL.$DOMAIN:18000/mcp"
}
access() { curl -s -X PUT "$GW/v1/admin/tools/$TOOL/access" -H "$P" -H "$J" -H "X-Sandbox-Identity: $(pid "${GITEA_HUMAN_USER:-doronec}")" -d "$1"; }
wait_cache() { sleep 16; }   # решение о доступе кэшируется 15 с
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


step "0. Сейчас тул открыт только владельцу"
access '{"groups":[],"people":[]}' >/dev/null; wait_cache
printf '  %-15s веб → %s\n' "$OUTSIDE" "$(web "$OUTSIDE")"
printf '  объяснение: %s\n' "$(perl -0pe 's/<[^>]+>/ /g; s/\s+/ /g' /tmp/sandbox-access-demo.html | sed -n 's/.*вам не открыт \(.*\)Страница тула.*/\1/p' | cut -c1-90)"

step "1. Человек просит доступ — заявка уходит владельцу"
OUT_ID=$(pid "$OUTSIDE")
curl -s -X POST "$GW/v1/admin/tools/$TOOL/access-request" -H "$P" -H "$J" -H "X-Sandbox-Identity: $OUT_ID" -d '{"note":"нужен для отчёта"}' \
  | sed -n 's/.*"owner":"\([^"]*\)".*/  заявка владельцу: \1/p'

step "2. Владелец открывает тул группе $GROUP — без передеплоя"
access "{\"groups\":[\"$GROUP\"]}" | sed -n 's/.*"groups":\[\([^]]*\)\].*/  доступ: группы \1/p'; echo
wait_cache
printf '  %-15s веб → %s (в группе)\n' "$INSIDE" "$(web "$INSIDE")"
printf '  %-15s веб → %s (вне группы)\n' "$OUTSIDE" "$(web "$OUTSIDE")"

step "3. Человек-исключение: подрядчик без группы"
access "{\"groups\":[\"$GROUP\"],\"people\":[\"$OUTSIDE\"]}" >/dev/null; wait_cache
printf '  %-15s веб → %s\n' "$OUTSIDE" "$(web "$OUTSIDE")"

step "4. Агентам можно запретить, оставив веб"
access "{\"agents\":false}" >/dev/null; wait_cache
printf '  %-15s mcp → %s, веб → %s\n' "$INSIDE" "$(mcp "$INSIDE")" "$(web "$INSIDE")"
access "{\"agents\":true}" >/dev/null; wait_cache
printf '  вернули агентов: mcp → %s\n' "$(mcp "$INSIDE")"

step "5. Источник ограничивает круг: это проверяет CI, до стенда не доходит"
node --disable-warning=ExperimentalWarning -e "
  const { validateManifest } = await import('./packages/manifest/src/index.ts');
  const registry = { policy: { max_ttl_days: 90 }, sources: { 'hr-people': { allowed_groups: ['hr'], datasets: {} } }, writes: {} };
  const manifest = { name: 'hr-board', owner: 'ivan.petrov', ttl_days: 30, sources: ['hr-people'], ui: { mode: ['web'] }, access: { groups: ['all-staff'], people: [], agents: true } };
  const r = validateManifest(manifest, registry);
  console.log('  ' + (r.ok ? 'пропущено — так быть не должно' : r.errors.map(e => e.path + ': ' + e.message).join('\n  ')));
"

step "6. Превью ветки — не для всех групп тула"
PREVIEW=$(curl -s "$GW/v1/admin/tools" -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" | tr ',' '\n' | sed -n "s/.*\"name\":\"\($TOOL--[a-z0-9-]*\)\".*/\1/p" | head -1)
if [ -n "$PREVIEW" ]; then
  printf '  %s: %s\n' "$PREVIEW" "$(curl -s "$GW/v1/admin/access-check?instance=$PREVIEW&login=$INSIDE" -H "$P" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' | cut -c1-90)"
else
  printf '  живых превью нет; правило: превью смотрят владелец и одобряющие, даже если прод открыт группе\n'
fi

step "7. Уборка: возвращаем как было — тул открыт только владельцу"
access '{"groups":[],"people":[],"agents":true}' >/dev/null
printf '  готово. Управление доступом — на странице тула: http://%s:18000/tools/%s\n' "$DOMAIN" "$TOOL"
