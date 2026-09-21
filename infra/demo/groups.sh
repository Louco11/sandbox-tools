#!/bin/sh
# Демо групп и администрирования (шаг Б3): группы песочницы заводит администратор, они доезжают до личности,
# исключение действует на следующем вызове, а не-администратор ничего изменить не может.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

GW=http://localhost:18080
DOMAIN=${SANDBOX_DOMAIN:-tools.localhost}
P="Authorization: Bearer $GATEWAY_PORTAL_TOKEN"
J='Content-Type: application/json'
GROUP=${GROUP:-sales-pilot}
ADMIN_LOGIN=${GITEA_HUMAN_USER:-doronec}
PERSON=${PERSON:-maria.volkova}

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
id() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" portal 5m web "${2:-}" 2>/dev/null | tail -1; }
session() { docker compose exec -T identity node infra/identity/src/mint.ts "$1" sandbox-session 10m web 2>/dev/null | tail -1; }
# один вызов — одна строка: код и объяснение гейтвея
say() { what=$1; shift; c=$(curl -s -o /tmp/sandbox-groups-demo.json -w '%{http_code}' "$@"); m=$(sed -n 's/.*"message":"\([^"]*\)".*/\1/p' /tmp/sandbox-groups-demo.json | cut -c1-70); printf '  %-28s → %s %s\n' "$what" "$c" "$m"; }
code() { curl -s -o /tmp/sandbox-groups-demo.json -w '%{http_code}' "$@"; }
# Группы человека так, как их увидит тул: спрашиваем ForwardAuth и смотрим выданную личность.
# Группы человека так, как их увидит тул. Спрашиваем про главную: тул мог бы отказать по доступу (шаг Б4),
# и тогда мы бы увидели отказ вместо групп.
groups_in_identity() {
  S=$(session "$1")
  docker compose exec -T notifier node -e "
    fetch('http://identity:8080/auth', { headers: { cookie: 'sandbox_session=$S', 'x-forwarded-host': '$DOMAIN', accept: 'text/html' } })
      .then(async r => { const t = r.headers.get('x-sandbox-identity');
        const p = t && JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
        console.log('  ' + '$1'.padEnd(15) + (p ? (p.groups.join(', ') || 'групп нет') : 'отказ входа: ' + r.status)); });" 2>/dev/null
}

# Следы прошлых прогонов убираем сами: демо должно давать один и тот же результат.
docker compose exec -T postgres psql -U sources_admin -d sources -qAt -c \
  "DELETE FROM gateway.group_members WHERE login = '$PERSON'; DELETE FROM gateway.groups WHERE name = '$GROUP'" >/dev/null

ADMIN=$(id "$ADMIN_LOGIN" sandbox-admins)
PLAIN=$(id "$PERSON")

step "1. Группу заводит администратор, посторонний — нет"
say "$PERSON (не админ)" -X POST $GW/v1/admin/groups -H "$P" -H "$J" -H "X-Sandbox-Identity: $PLAIN" -d "{\"name\":\"$GROUP\",\"title\":\"Пилот продаж\"}"
say "$ADMIN_LOGIN (админ)" -X POST $GW/v1/admin/groups -H "$P" -H "$J" -H "X-Sandbox-Identity: $ADMIN" -d "{\"name\":\"$GROUP\",\"title\":\"Пилот продаж\"}"

step "2. Участие — со сроком: до конца пилота"
say "$PERSON на 30 дней" -X POST "$GW/v1/admin/groups/$GROUP/members" -H "$P" -H "$J" -H "X-Sandbox-Identity: $ADMIN" -d "{\"login\":\"$PERSON\",\"days\":30}"
sleep 61   # группы в личности кэшируются на минуту: новая группа видна не позже этого
groups_in_identity "$PERSON"

step "3. Просроченное участие не действует"
docker compose exec -T postgres psql -U sources_admin -d sources -qAt -c \
  "UPDATE gateway.group_members SET expires_at = now() - interval '1 hour' WHERE group_name = '$GROUP' AND login = '$PERSON'" >/dev/null
sleep 61   # личность кэширует группы на минуту: дольше ждать не придётся
groups_in_identity "$PERSON"

step "4. Вернули участие бессрочно и снова убрали человека"
code -X POST "$GW/v1/admin/groups/$GROUP/members" -H "$P" -H "$J" -H "X-Sandbox-Identity: $ADMIN" -d "{\"login\":\"$PERSON\"}" >/dev/null
say "убрали из группы" -X DELETE "$GW/v1/admin/groups/$GROUP/members/$PERSON" -H "$P" -H "X-Sandbox-Identity: $ADMIN"
sleep 61
groups_in_identity "$PERSON"

step "5. Журнал: кто что менял"
curl -s "$GW/v1/admin/groups-journal?limit=6" -H "$P" \
  | sed -n 's/.*"journal":\[//p' | tr '}' '\n' | sed -n 's/.*"actor":"\([^"]*\)".*"operation":"\([^"]*\)".*"reason":"\{0,1\}\([^,"]*\).*/  \1 — \2 — \3/p' | head -6

step "6. Уборка: группа больше не нужна"
say "группа удалена" -X DELETE "$GW/v1/admin/groups/$GROUP" -H "$P" -H "X-Sandbox-Identity: $ADMIN"
printf '\n  Админ-панель человека: http://%s:18000/admin (только группа sandbox-admins)\n' "$DOMAIN"
