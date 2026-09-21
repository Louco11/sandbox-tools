#!/bin/sh
# Создаёт .env и дописывает недостающие секреты. Существующие значения не трогает.
set -eu
cd "$(dirname "$0")/.."

touch .env
secret() { openssl rand -hex "${1:-16}"; }

ensure() {
  grep -q "^$1=" .env || { echo "$1=$2" >> .env; echo "  + $1"; }
}

# Часовой пояс стенда — для времени на главной (по умолчанию — пояс хоста).
ensure SANDBOX_TZ "$( (readlink /etc/localtime 2>/dev/null || true) | sed -n 's|.*zoneinfo/||p' | grep . || cat /etc/timezone 2>/dev/null || echo UTC)"

ensure GITEA_ADMIN_USER sandbox-admin
ensure GITEA_ADMIN_PASSWORD "$(secret 12)"
ensure RUNNER_REGISTRATION_TOKEN "$(secret 20)"
# Агенты пушат ветки и открывают PR под своей учётной записью; в main — только через PR, одобренный человеком.
ensure GITEA_AGENT_USER sandbox-agent
ensure GITEA_AGENT_PASSWORD "$(secret 16)"
# Человек, который одобряет и мержит PR в main. Его пароль в .env не хранится — задаёт он сам.
ensure GITEA_HUMAN_USER "$(id -un | tr '[:upper:]' '[:lower:]')"

ensure PG_ADMIN_PASSWORD "$(secret)"
ensure PG_TASKS_READONLY_PASSWORD "$(secret)"
ensure PG_KNOWLEDGE_READONLY_PASSWORD "$(secret)"
ensure PG_TASKS_CREATE_PASSWORD "$(secret)"
ensure PG_TASKS_UPDATE_PASSWORD "$(secret)"
ensure PG_KNOWLEDGE_NOTE_CREATE_PASSWORD "$(secret)"
ensure PG_BOARDS_READONLY_PASSWORD "$(secret)"
ensure PG_BOARDS_CREATE_PASSWORD "$(secret)"
ensure PG_BOARDS_SAVE_PASSWORD "$(secret)"
ensure PG_PASTRY_READONLY_PASSWORD "$(secret)"
ensure PG_PASTRY_CLIENT_CREATE_PASSWORD "$(secret)"
ensure PG_PASTRY_CLIENT_UPDATE_PASSWORD "$(secret)"
ensure PG_PASTRY_CAKE_TYPE_CREATE_PASSWORD "$(secret)"
ensure PG_PASTRY_CAKE_TYPE_UPDATE_PASSWORD "$(secret)"
ensure PG_PASTRY_RECIPE_UPSERT_PASSWORD "$(secret)"
ensure PG_PASTRY_RECIPE_DELETE_PASSWORD "$(secret)"
ensure PG_PASTRY_INGREDIENT_CREATE_PASSWORD "$(secret)"
ensure PG_PASTRY_INGREDIENT_UPDATE_PASSWORD "$(secret)"
ensure PG_PASTRY_STOCK_RECEIVE_PASSWORD "$(secret)"
ensure PG_PASTRY_STOCK_ADJUST_PASSWORD "$(secret)"
ensure PG_PASTRY_ORDER_CREATE_PASSWORD "$(secret)"
ensure PG_PASTRY_ORDER_UPDATE_PASSWORD "$(secret)"
ensure PG_PASTRY_ORDER_START_BAKING_PASSWORD "$(secret)"
ensure PG_GATEWAY_PASSWORD "$(secret)"
ensure PG_IDENTITY_PASSWORD "$(secret)"   # личные ключи MCP: своя схема, данных источников не видит

ensure GATEWAY_JWT_SECRET "$(secret 32)"
# Сервисные токены гейтвея — по роли на сервис: чем меньше прав у токена, тем меньше радиус утечки.
ensure GATEWAY_ADMIN_TOKEN "$(secret 24)"    # человек: make tools / extend / revoke
ensure GATEWAY_DEPLOY_TOKEN "$(secret 24)"   # деплоер и make deploy: только допуск тула
ensure GATEWAY_REAPER_TOKEN "$(secret 24)"   # уборщик: список и простой
ensure GATEWAY_PORTAL_TOKEN "$(secret 24)"   # главная страница: только чтение
ensure GATEWAY_NOTIFIER_TOKEN "$(secret 24)" # сервис уведомлений: только справочник — кому доставить
ensure GATEWAY_IDENTITY_TOKEN "$(secret 24)" # сервис личности: группы песочницы для личности
# IdP стенда (Keycloak) и личность. Пароль человека временный: сменить при первом входе.
ensure KEYCLOAK_ADMIN_USER admin
ensure KEYCLOAK_ADMIN_PASSWORD "$(secret 12)"
ensure KEYCLOAK_HUMAN_PASSWORD "$(secret 6)"
ensure KEYCLOAK_DEMO_PASSWORD "$(secret 6)"
# Сервис уведомлений: у каждого отправителя и читателя свой токен.
ensure NOTIFY_REAPER_TOKEN "$(secret 24)"
ensure NOTIFY_DEPLOYER_TOKEN "$(secret 24)"
ensure NOTIFY_PORTAL_TOKEN "$(secret 24)"    # главная: входящие человека
# Деплоер читает репозиторий и пишет статус выкатки коммита.
ensure GITEA_DEPLOYER_USER sandbox-deployer
ensure GITEA_DEPLOYER_PASSWORD "$(secret 16)"
# Стенд различается по id: бэкап своего стенда восстанавливается целиком, чужого — без тулов (infra/backup).
ensure SANDBOX_STAND_ID "$(openssl rand -hex 16)"
# SANDBOX_BACKUP_DIR — каталог на внешнем диске или NAS; задаёт человек (make backup без него не работает).
# Токены коннекторов источников: по ним коннектор узнаёт гейтвей (token_env в реестре).
ensure CONNECTOR_SUPPLIERS_TOKEN "$(secret 24)"
ensure CONNECTOR_TASKS_TOKEN "$(secret 24)"
ensure CONNECTOR_KNOWLEDGE_TOKEN "$(secret 24)"
ensure CONNECTOR_BOARDS_TOKEN "$(secret 24)"
ensure CONNECTOR_PASTRY_TOKEN "$(secret 24)"
