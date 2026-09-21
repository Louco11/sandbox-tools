#!/bin/sh
# Демо уведомлений и справочника (шаг А3): простой, скорое удаление, потолок автопродления, ушедший владелец,
# владелец-группа, ничей тул. Тулы регистрируются в гейтвее без контейнеров и в конце отзываются.
set -eu
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a

GW=http://localhost:18080
ADMIN="Authorization: Bearer $GATEWAY_ADMIN_TOKEN"
PORTAL="Authorization: Bearer $GATEWAY_PORTAL_TOKEN"
J='Content-Type: application/json'
HUMAN=${GITEA_HUMAN_USER:-doronec}
START=$(date -u +%Y-%m-%dT%H:%M:%S)   # входящие показываем только за этот прогон

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
register() { # имя владелец
  curl -sf -X POST $GW/v1/admin/tools -H "$J" -H "$ADMIN" \
    -d "{\"manifest\":{\"name\":\"$1\",\"owner\":\"$2\",\"ttl_days\":30,\"sources\":[\"knowledge-readonly\"],\"ui\":{\"mode\":[\"web\"]}}}" >/dev/null
  echo "  $1 — владелец $2"
}
sql() { docker compose exec -T postgres psql -U sources_admin -d sources -qAt -c "$1"; }
extend() { # тул кто — продление с главной от имени человека
  code=$(curl -s -o /tmp/sandbox-notify-demo.json -w '%{http_code}' -X POST "$GW/v1/admin/tools/$1/extend" -H "$J" -H "$PORTAL" \
    -H "X-Sandbox-Identity: $(docker compose exec -T identity node infra/identity/src/mint.ts "$2" portal 2m 2>/dev/null | tail -1)" -d '{"days":30}')
  printf '  %-15s → %s %s\n' "$2" "$code" "$(jq -r '.message // .expires_at' /tmp/sandbox-notify-demo.json)"
}
inbox() { # логин
  docker compose exec -T notifier node -e "
    fetch('http://localhost:8080/inbox?to=$1',{headers:{Authorization:'Bearer '+process.env.NOTIFY_PORTAL_TOKEN}})
      .then(r=>r.json()).then(b=>{ const m=b.messages.filter(x=>/demo-notify/.test(x.subject) && x.at >= '$START');
        console.log('  '+'$1'.padEnd(15)+m.length+' шт.'); for (const x of m) console.log('    · '+x.subject+(x.note?'  ('+x.note+')':'')) })"
}

step "1. Справочник: кто решает за владельца"
for n in "$HUMAN" sergey.nikitin pavel.orlov support-team; do
  docker compose exec -T notifier node -e "fetch('http://gateway:8080/v1/admin/directory/resolve?name=$n',{headers:{Authorization:'Bearer '+process.env.GATEWAY_NOTIFIER_TOKEN}}).then(r=>r.json()).then(r=>console.log('  '+'$n'.padEnd(15)+' → '+(r.logins.join(', ')||'никто')+'  ['+r.kind+']'+(r.note?' '+r.note:'')))"
done

step "2. Регистрируем тулы с разными владельцами"
# Отозванный тул заново не допускается, пока уборщик не уберёт его строку (через неделю) — следы прошлого прогона убираем сами.
sql "DELETE FROM gateway.tools WHERE name LIKE 'demo-notify-%'"
register demo-notify-idle anna.smirnova
register demo-notify-left sergey.nikitin
register demo-notify-group support-team
register demo-notify-orphan pavel.orlov

step "3. Двигаем время: простой 40 дней, срок через 2 дня, потолок автопродления через 5 дней"
sql "UPDATE gateway.tools SET confirmed_at = now() - interval '40 days', last_human_at = now() - interval '40 days' WHERE name = 'demo-notify-idle'"
sql "UPDATE gateway.tools SET expires_at = now() + interval '2 days' WHERE name = 'demo-notify-left'"
sql "UPDATE gateway.tools SET confirmed_at = now() - interval '85 days', last_human_at = now() WHERE name = 'demo-notify-group'"
echo "  готово"

step "4. Продление с главной: гейтвей пускает только того, кто решает за владельца"
extend demo-notify-left sergey.nikitin
extend demo-notify-left anna.smirnova
extend demo-notify-left igor.kozlov
extend demo-notify-group anna.smirnova
extend demo-notify-group maria.volkova
sql "UPDATE gateway.tools SET expires_at = now() + interval '2 days' WHERE name = 'demo-notify-left'"
sql "UPDATE gateway.tools SET confirmed_at = now() - interval '85 days', last_human_at = now() WHERE name = 'demo-notify-group'"

step "5. Ждём проход уборщика (до 40 с)"
i=0
until [ "$(sql "SELECT count(*) FROM gateway.tools WHERE name IN ('demo-notify-idle','demo-notify-orphan') AND idle_notified_at IS NOT NULL")" = 2 ] || [ $i -ge 40 ]; do sleep 1; i=$((i+1)); done
sleep 3
sql "SELECT name || ': удаление ' || to_char(expires_at, 'DD.MM') || CASE WHEN idle_notified_at IS NULL THEN '' ELSE ' (простой)' END FROM gateway.tools WHERE name LIKE 'demo-notify-%' ORDER BY name" | sed 's/^/  /'

step "6. Входящие (на главной: http://${SANDBOX_DOMAIN:-tools.localhost}:18000/inbox под своим логином)"
for n in anna.smirnova igor.kozlov maria.volkova "$HUMAN" sergey.nikitin pavel.orlov; do inbox "$n"; done

step "7. Уборка: отзываем демо-тулы"
for t in demo-notify-idle demo-notify-left demo-notify-group demo-notify-orphan; do
  curl -sf -X POST "$GW/v1/admin/tools/$t/revoke" -H "$J" -H "$ADMIN" -d '{"reason":"make demo-notify"}' >/dev/null && echo "  $t отозван"
done
