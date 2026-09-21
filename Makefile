.PHONY: setup stand demo-forge lan local demo-identity demo-groups demo-access demo-data-rights demo-notify demo-connector validate-connector up bundle backup backup-verify backup-schedule restore migrate down reset ps logs psql env demo-gateway ci-image check deploy tools extend revoke agents

# Команды стенда — только на сервере. Рабочая копия из infra/remote.sh стенда не имеет и второй не поднимает.
stand:
	@! grep -q '^SANDBOX_REMOTE=1' .env 2>/dev/null || { echo "✗ это рабочая копия, подключённая к стенду $$(sed -n 's/^SANDBOX_HOST=//p' .env) — команды стенда выполняются на сервере"; exit 1; }

lan: stand ## Открыть стенд в локальную сеть: make lan HOST=192.168.1.10 [DOMAIN=…] — только до настоящей авторизации
	@./infra/lan.sh lan "$(HOST)" "$(DOMAIN)"

local: stand ## Вернуть стенд только на это устройство (127.0.0.1, *.tools.localhost)
	@./infra/lan.sh local

setup: ## Первый запуск в свежей копии: проверить окружение, поднять стенд, проверить здоровье
	@./infra/setup.sh

up: stand env ci-image ## Поднять стенд целиком
	docker compose up -d --build --wait
	./infra/bootstrap.sh

bundle: ## Архив платформы для другого устройства: main без тулов, секретов и истории (infra/install.sh)
	@./infra/install.sh bundle

public: ## Публичный экспорт в dist/public: платформа без тулов, секретов и личных данных (не пушит)
	@./infra/publish.sh


migrate: stand env ## Досоздать новые источники и гранты на живом стенде без потери данных (идемпотентно)
	docker compose up -d --wait postgres
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/06-gateway-grants.sh
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/07-tool-history.sh
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/08-identity.sh
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/09-groups.sh
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/10-tool-access.sh
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/11-access-requests.sh
	docker compose exec -T postgres sh /docker-entrypoint-initdb.d/12-forge-tokens.sh
	docker compose up -d --build --wait gateway

env:
	@./infra/init-env.sh

ci-image: stand ## Образ джоб Gitea Actions (только Node: CI проверяет, выкатывает деплоер)
	docker build -q -t sandbox-ci:latest infra/ci

down: stand ## Остановить, данные сохранятся
	docker compose down

reset: stand ## Снести всё вместе с данными
	docker compose down -v

ps:
	docker compose ps

logs:
	docker compose logs -f --tail=100

psql: stand ## Консоль Postgres под админом (порт наружу не публикуется)
	docker compose exec postgres psql -U sources_admin -d sources

demo-gateway: stand ## Демо гейтвея: скоуп, записи, MCP, аудит
	./infra/demo/gateway.sh

validate-connector: ## Контракт коннектора на тестовых данных: make validate-connector NAME=suppliers
	@node --disable-warning=ExperimentalWarning packages/connector/src/validate.ts $(NAME)

demo-identity: stand ## Демо личности: без входа до тула не дойти, чужая и просроченная личность отвергается
	./infra/demo/identity.sh

demo-groups: stand ## Демо групп: администратор заводит группу, она доезжает до личности, исключение действует сразу
	./infra/demo/groups.sh

demo-access: stand ## Демо доступа: тул открыт кругу людей, источник ограничивает круг, агентов можно запретить
	./infra/demo/access.sh

demo-data-rights: stand ## Демо прав на данные: чувствительные поля, фильтр строк, запись по группам
	./infra/demo/data-rights.sh

demo-forge: stand ## Демо Б6: у каждого человека свой агент в репозитории, пароля учётки на машине нет
	@./infra/demo/forge.sh

demo-notify: stand ## Демо уведомлений и справочника: простой, срок, ушедший владелец, группа, ничей тул
	./infra/demo/notify.sh

demo-connector: stand ## Демо коннектора: второй источник без правки гейтвея, записи, изоляция, реестр без перезапуска
	./infra/demo/connector.sh

agents: ## Конфиги MCP для Claude Code, Cursor, OpenCode из списка тулов
	node --disable-warning=ExperimentalWarning infra/agents/sync.ts

check: ## Контракт допуска и типы — то же, что в CI
	node packages/manifest/src/cli.ts
	npm run typecheck

deploy: stand ## Выкатить тул вручную из рабочей копии (обычно это делает деплоер): make deploy TOOL=manager-board
	node charts/tool-base/deploy.ts $(TOOL)

tools: stand ## Тулы в контуре: срок жизни, предел автопродления, последний заход человека
	@set -a; . ./.env; curl -s -H "Authorization: Bearer $$GATEWAY_ADMIN_TOKEN" localhost:18080/v1/admin/tools \
	  | jq -r '["tool","expires","auto-extend-cap","last-human","status","sources"], (.tools[] | select(.revoked_at == null) | [.name, .expires_at[:16], ((.auto_extend_until // "—")[:10]), ((.last_human_at // "—")[:16]), (if .idle_notified_at then "idle" else "active" end), (.sources|join(","))]) | @tsv' | column -t -s "$$(printf '\t')"
	@set -a; . ./.env; curl -s -H "Authorization: Bearer $$GATEWAY_ADMIN_TOKEN" localhost:18080/v1/admin/tools \
	  | jq -r '[.tools[] | select(.revoked_at != null)] | length | if . > 0 then "\n\(.) отозванных инстансов скрыто — уборщик уберёт их строки через неделю" else "" end'

extend: stand ## Продлить тул: make extend TOOL=manager-board DAYS=30
	@set -a; . ./.env; curl -s -X POST -H "Authorization: Bearer $$GATEWAY_ADMIN_TOKEN" -H 'Content-Type: application/json' \
	  localhost:18080/v1/admin/tools/$(TOOL)/extend -d '{"days":$(DAYS)}' | jq .

revoke: stand ## Досрочно завершить тул: make revoke TOOL=… (уборщик удалит контейнер)
	@set -a; . ./.env; curl -s -X POST -H "Authorization: Bearer $$GATEWAY_ADMIN_TOKEN" \
	  localhost:18080/v1/admin/tools/$(TOOL)/revoke | jq .

backup: stand ## Бэкап стенда в SANDBOX_BACKUP_DIR (внешний диск/NAS), зашифрован; хранятся 7 ежедневных + 4 еженедельных
	@node --disable-warning=ExperimentalWarning infra/backup/backup.ts backup

backup-verify: stand ## Проверить бэкап восстановлением во временный Postgres: make backup-verify [FILE=…]
	@node --disable-warning=ExperimentalWarning infra/backup/backup.ts verify $(FILE)

backup-schedule: stand ## Ежедневный make backup в 03:00 (launchd на macOS)
	@node --disable-warning=ExperimentalWarning infra/backup/backup.ts schedule

restore: stand ## Восстановить стенд (только человек, в терминале): make restore FILE=… [ADOPT=1 — тулы чужого стенда]
	@node --disable-warning=ExperimentalWarning infra/backup/backup.ts restore $(FILE) $(if $(ADOPT),--adopt-tools)
