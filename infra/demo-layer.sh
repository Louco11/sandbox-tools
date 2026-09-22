#!/bin/sh
# Демо-слой: источники, на которых песочницу можно потрогать, ничего не подключая.
#
#   sh infra/demo-layer.sh on    включить: реестр, данные и коннекторы демо
#   sh infra/demo-layer.sh off   выключить: в контуре остаются только источники стенда
#   sh infra/demo-layer.sh       что сейчас
#
# Один выключатель на всё: SANDBOX_DEMO в .env. От него зависят гейтвей (склейка реестра), Postgres
# (наливать ли демо-схемы) и профиль compose «demo» (поднимать ли демо-коннекторы).
# Данные демо не удаляются при выключении: схемы остаются в базе, но из контура источники уходят.
set -eu
cd "$(dirname "$0")/.."

say() { printf '→ %s\n' "$*"; }
state() { (grep -q '^SANDBOX_DEMO=1' .env 2>/dev/null && echo on) || echo off; }

set_env() { # set_env <ключ> <значение>
  touch .env
  if grep -q "^$1=" .env; then
    tmp=$(mktemp); grep -v "^$1=" .env > "$tmp"; printf '%s=%s\n' "$1" "$2" >> "$tmp"; mv "$tmp" .env
  else
    printf '%s=%s\n' "$1" "$2" >> .env
  fi
}

case "${1:-status}" in
  on)
    set_env SANDBOX_DEMO 1
    set_env COMPOSE_PROFILES demo
    say "демо-слой включён в .env"
    say "поднимаю демо-коннекторы"
    docker compose up -d --wait connector-tasks connector-knowledge connector-boards connector-pastry connector-suppliers
    say "наливаю демо-данные (идемпотентно)"
    for f in infra/postgres/demo/*.sql infra/postgres/demo/*.sh; do
      [ -e "$f" ] || continue
      case "$f" in
        *.sql) docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U sources_admin -d sources -f "/demo/$(basename "$f")" >/dev/null 2>&1 || true ;;
        *.sh)  docker compose exec -T postgres sh "/demo/$(basename "$f")" >/dev/null 2>&1 || true ;;
      esac
      printf '  ✓ %s\n' "$(basename "$f")"
    done
    say "перечитываю реестр"
    docker compose up -d --force-recreate --wait gateway >/dev/null
    ;;
  off)
    set_env SANDBOX_DEMO 0
    set_env COMPOSE_PROFILES ""
    say "демо-слой выключен в .env"
    say "гашу демо-коннекторы"
    docker compose rm -sf connector-tasks connector-knowledge connector-boards connector-pastry connector-suppliers >/dev/null 2>&1 || true
    say "перечитываю реестр"
    docker compose up -d --force-recreate --wait gateway >/dev/null
    say "данные демо остались в базе; убрать совсем — make reset (снесёт стенд целиком)"
    ;;
  status|*) ;;
esac

printf '\nДемо-слой: %s\n' "$(state)"
curl -fsS http://localhost:18080/v1/registry 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log("Источников в контуре:",Object.keys(r.sources).join(", ")||"нет","| прав записи:",Object.keys(r.writes).length)})' \
  || echo "Гейтвей не отвечает — стенд поднят?"
