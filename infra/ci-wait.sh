#!/bin/sh
# Ждёт прогон Gitea Actions для коммита и печатает итог и значимые строки лога.
#   infra/ci-wait.sh [sha]      по умолчанию HEAD; после зелёного CI ждёт выкатку деплоером
set -eu
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
SHA=${1:-$(git rev-parse HEAD)}
# Учётка агента, а не админа: скрипт работает и с удалённой рабочей копии (infra/remote.sh).
A="$GITEA_AGENT_USER:$GITEA_AGENT_PASSWORD"
H=${SANDBOX_HOST:-localhost}
API=http://$H:13000/api/v1/repos/platform/internal-tools/actions

i=0
while :; do
  RUN=$(curl -s -u "$A" "$API/tasks?limit=50" | jq -c --arg s "$SHA" '[.workflow_runs[] | select(.head_sha==$s)][0] // {}')
  STATUS=$(echo "$RUN" | jq -r '.status // "queued"')
  case "$STATUS" in success|failure|cancelled|skipped) break ;; esac
  i=$((i + 1)); [ $i -gt 180 ] && { echo "таймаут ожидания CI"; exit 1; }
  sleep 5
done

ID=$(echo "$RUN" | jq -r .id)
echo "CI $SHA: $STATUS  (http://$H:13000/platform/internal-tools/actions/runs/$(echo "$RUN" | jq -r .run_number))"
curl -s -u "$A" "$API/jobs/$ID/logs" | sed -E 's/^[0-9TZ:.-]+ //' \
  | grep -E '✓|✗|тулов прошли|▶|допуск:|образ:|готово за|web:|mcp:|    tools/|Error|error TS|не допустил|деплоить нечего|Job (succeeded|failed)' | grep -v '::error' || true
[ "$STATUS" = success ] || exit 1

# Выкатывает не CI, а деплоер — после зелёного прогона. Ждём и его.
i=0
while :; do
  D=$(curl -s "http://$H:18090/deploys/$SHA" || echo '{"state":"waiting"}')
  STATE=$(printf '%s' "$D" | jq -r .state)
  case "$STATE" in success|failure|skipped) break ;; esac
  i=$((i + 1)); [ $i -gt 180 ] && { echo "таймаут ожидания деплоера"; exit 1; }
  sleep 3
done
echo "Выкатка $SHA: $STATE  (http://$H:18090/deploys/$SHA)"
printf '%s' "$D" | jq -r .log | grep -E '▶|✗|допуск:|образ:|готово за|web:|mcp:|не допустил|не поднялся|деплоить нечего|не выкачены' || true
[ "$STATE" = success ]
