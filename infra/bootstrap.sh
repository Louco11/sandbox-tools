#!/bin/sh
# Доводит Gitea до рабочего состояния: админ, организация, репозиторий, первый пуш.
# Идемпотентен: повторный запуск ничего не ломает.
set -eu
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

GITEA=http://localhost:13000
ORG=platform
REPO=internal-tools
AUTH="$GITEA_ADMIN_USER:$GITEA_ADMIN_PASSWORD"

api() { curl -fsS -u "$AUTH" -H 'Content-Type: application/json' "$@"; }
exists() { curl -s -o /dev/null -w '%{http_code}' -u "$AUTH" "$1" | grep -q '^200$'; }

echo "→ сид Postgres"
SEED=$(docker compose exec -T postgres psql -U sources_admin -d sources -tAc \
  "select shobj_description(oid, 'pg_database') from pg_database where datname = 'sources'")
if [ "$SEED" != "seed:ok" ]; then
  echo "Сид Postgres не завершён. Причина: docker compose logs postgres | grep ERROR"
  echo "После исправления: docker compose rm -sfv postgres && docker volume rm sandbox_pgdata && make up"
  exit 1
fi

echo "→ жду Gitea"
until curl -fsS "$GITEA/api/healthz" >/dev/null 2>&1; do sleep 1; done

echo "→ админ $GITEA_ADMIN_USER"
if ! exists "$GITEA/api/v1/user"; then
  docker compose exec -T -u git gitea gitea admin user create \
    --admin --username "$GITEA_ADMIN_USER" --password "$GITEA_ADMIN_PASSWORD" \
    --email admin@sandbox.local --must-change-password=false >/dev/null
fi

echo "→ организация $ORG"
exists "$GITEA/api/v1/orgs/$ORG" || api -X POST "$GITEA/api/v1/orgs" \
  -d "{\"username\":\"$ORG\",\"full_name\":\"Платформа внутренних тулов\",\"visibility\":\"private\"}" >/dev/null

echo "→ репозиторий $ORG/$REPO"
exists "$GITEA/api/v1/repos/$ORG/$REPO" || api -X POST "$GITEA/api/v1/orgs/$ORG/repos" \
  -d "{\"name\":\"$REPO\",\"private\":true,\"default_branch\":\"main\",\"description\":\"Песочница внутренних тулов\"}" >/dev/null

# У CI секретов нет: workflow берётся из ветки. Секрет со старых стендов удаляем.
echo "→ секретов CI нет"
curl -s -o /dev/null -u "$AUTH" -X DELETE "$GITEA/api/v1/repos/$ORG/$REPO/actions/secrets/GATEWAY_ADMIN_TOKEN"

# Смерженная ветка удаляется сама — и вместе с ней деплоер отзывает её превью.
echo "→ удаление ветки после мержа PR"
api -X PATCH "$GITEA/api/v1/repos/$ORG/$REPO" -d '{"default_delete_branch_after_merge":true}' >/dev/null

echo "→ git remote"
git remote get-url gitea >/dev/null 2>&1 || git remote add gitea "$GITEA/$ORG/$REPO.git"

# Первый пуш main — только в пустой репозиторий. Дальше main меняется исключительно через PR.
if git rev-parse --verify -q main >/dev/null && ! exists "$GITEA/api/v1/repos/$ORG/$REPO/branches/main"; then
  echo "→ первый пуш main"
  BASIC=$(printf '%s' "$AUTH" | base64)
  git -c credential.helper= -c http.extraHeader="Authorization: Basic $BASIC" push -q gitea main:main
fi

user_exists() { exists "$GITEA/api/v1/users/$1"; }
collaborator() {
  api -X PUT "$GITEA/api/v1/repos/$ORG/$REPO/collaborators/$1" -d '{"permission":"write"}' >/dev/null
}

echo "→ агент $GITEA_AGENT_USER: пушит ветки и открывает PR, в main не пишет"
if ! user_exists "$GITEA_AGENT_USER"; then
  docker compose exec -T -u git gitea gitea admin user create \
    --username "$GITEA_AGENT_USER" --password "$GITEA_AGENT_PASSWORD" \
    --email agent@sandbox.local --must-change-password=false >/dev/null
fi
collaborator "$GITEA_AGENT_USER"

echo "→ деплоер $GITEA_DEPLOYER_USER: читает коммиты и пишет статус выкатки"
if ! user_exists "$GITEA_DEPLOYER_USER"; then
  docker compose exec -T -u git gitea gitea admin user create \
    --username "$GITEA_DEPLOYER_USER" --password "$GITEA_DEPLOYER_PASSWORD" \
    --email deployer@sandbox.local --must-change-password=false >/dev/null
fi
collaborator "$GITEA_DEPLOYER_USER"

echo "→ человек $GITEA_HUMAN_USER: одобряет и мержит PR в main"
if ! user_exists "$GITEA_HUMAN_USER"; then
  # Пароль случайный и нигде не сохраняется: агентам с доступом к .env он недоступен. Человек задаёт свой.
  docker compose exec -T -u git gitea gitea admin user create \
    --username "$GITEA_HUMAN_USER" --random-password \
    --email "$GITEA_HUMAN_USER@sandbox.local" --must-change-password=false >/dev/null
  HUMAN_NEW=1
fi
collaborator "$GITEA_HUMAN_USER"

echo "→ защита main: без прямого пуша, мерж через PR после одобрения человеком и зелёного CI"
PROTECTION=$(cat <<JSON
{
  "rule_name": "main",
  "enable_push": false,
  "enable_merge_whitelist": true,
  "merge_whitelist_usernames": ["$GITEA_HUMAN_USER"],
  "required_approvals": 1,
  "enable_approvals_whitelist": true,
  "approvals_whitelist_username": ["$GITEA_HUMAN_USER"],
  "enable_status_check": true,
  "status_check_contexts": ["tools / pipeline (push)"],
  "block_on_rejected_reviews": true,
  "block_on_outdated_branch": false,
  "dismiss_stale_approvals": true,
  "block_admin_merge_override": true
}
JSON
)
if exists "$GITEA/api/v1/repos/$ORG/$REPO/branch_protections/main"; then
  api -X PATCH "$GITEA/api/v1/repos/$ORG/$REPO/branch_protections/main" -d "$PROTECTION" >/dev/null
else
  api -X POST "$GITEA/api/v1/repos/$ORG/$REPO/branch_protections" -d "$PROTECTION" >/dev/null
fi

echo "→ раннер"
i=0
until docker compose logs runner 2>/dev/null | grep -q 'declare successfully'; do
  i=$((i + 1)); [ $i -gt 60 ] && { echo "раннер не зарегистрировался, см. docker compose logs runner"; exit 1; }
  sleep 1
done

echo
echo "Готово."
echo "  Gitea:     $GITEA/$ORG/$REPO   (логин и пароль в .env)"
echo "  Actions:   $GITEA/$ORG/$REPO/actions"
echo "  Гейтвей:   http://localhost:18080/v1/registry"
echo "  Traefik:   http://traefik.tools.localhost:18000/dashboard/"
echo "  Тулы:      http://<tool>.tools.localhost:18000   (make tools — список)"
echo "  Вход:      http://auth.tools.localhost:18000   (IdP стенда; временный пароль — KEYCLOAK_HUMAN_PASSWORD в .env,"
echo "             IdP попросит сменить его при первом входе)"
if [ "${HUMAN_NEW:-}" = 1 ]; then
  echo
  echo "Задайте пароль своей учётной записи Gitea ($GITEA_HUMAN_USER) — им вы одобряете PR в main:"
  echo "  docker compose exec -u git gitea gitea admin user change-password --username $GITEA_HUMAN_USER --password '<ваш пароль>'"
fi
