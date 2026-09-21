#!/bin/sh
# Открыть стенд в локальную сеть или вернуть его только на это устройство. Запускается на сервере стенда.
#
#   make lan HOST=192.168.1.10 [DOMAIN=…]   порты на всех интерфейсах, тулы — <тул>.tools.192.168.1.10.sslip.io:18000
#   make local                              обратно: только 127.0.0.1, тулы — <тул>.tools.localhost:18000
#
# sslip.io — публичный DNS, который отвечает IP-адресом из самого имени: *.tools.192.168.1.10.sslip.io → 192.168.1.10.
# Свой DNS не нужен, но нужен выход в интернет для DNS. Свой домен с wildcard-записью — DOMAIN=tools.example.lan.
#
# ВНИМАНИЕ: SSO пока заглушка — любой в сети может войти в тул под любым логином и подтвердить запись.
# Режим только для доверенной сети и тестирования, до настоящей авторизации.
set -eu
cd "$(dirname "$0")/.."

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
say() { printf '→ %s\n' "$*"; }

set_env() { # set_env KEY VALUE — заменить или дописать строку в .env
  if grep -q "^$1=" .env; then
    tmp=$(mktemp); grep -v "^$1=" .env > "$tmp"; cat "$tmp" > .env; rm -f "$tmp"
  fi
  echo "$1=$2" >> .env
}
unset_env() {
  tmp=$(mktemp); grep -v "^$1=" .env > "$tmp" || true; cat "$tmp" > .env; rm -f "$tmp"
}

# Тулы с новым доменом: деплоер забывает, что уже выкатил, и выкатывает main и ветки заново.
redeploy() {
  say "стенд с новыми адресами"
  docker compose up -d --wait >/dev/null
  say "перевыкатка тулов под новый домен"
  # Журнал выкаток (/state/deploys) не трогаем: по нему деплоер отзывает превью удалённых веток.
  docker compose exec -T deployer rm -f /state/done.json
  docker compose restart deployer >/dev/null
}

[ -f .env ] || die "нет .env — сначала make up"
# Источник правды — .env: унаследованные из оболочки значения compose предпочёл бы ему.
unset SANDBOX_HOST SANDBOX_DOMAIN SANDBOX_BIND
grep -q '^SANDBOX_REMOTE=1' .env && die "это удалённая рабочая копия, а не сервер стенда"

case "${1:-}" in
  lan)
    host=${2:-}
    [ -n "$host" ] || die "укажите адрес сервера в локальной сети: make lan HOST=192.168.1.10"
    domain=${3:-}
    if [ -z "$domain" ]; then
      echo "$host" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' \
        || die "для имени хоста укажите домен с wildcard DNS: make lan HOST=$host DOMAIN=tools.example.lan (или HOST=<ip>)"
      domain="tools.$host.sslip.io"
    fi
    probe=$(node -e "require('node:dns').lookup('probe.$domain',{family:4},(e,a)=>console.log(e?'':a))")
    if [ "$probe" != "$host" ]; then
      echo "! probe.$domain не резолвится в $host (получено: ${probe:-ничего})."
      echo "  Роутер или DNS может блокировать ответы с частными адресами (защита от DNS rebinding)."
      echo "  Тогда тулы по имени не откроются; выход — свой DNS или SSH-туннель (README)."
    fi
    set_env SANDBOX_HOST "$host"
    set_env SANDBOX_DOMAIN "$domain"
    set_env SANDBOX_BIND 0.0.0.0
    redeploy
    set -a; . ./.env; set +a
    cat <<EOF

Стенд открыт в локальную сеть.
  Главная:  http://$domain:18000
  Gitea:    http://$host:13000/platform/internal-tools
  Тулы:     http://<тул>.$domain:18000

! SSO — заглушка: любой в этой сети может войти в тул под любым логином. Только доверенная сеть, только для тестов.

На ноутбуке — рабочая копия для агента, подключённая к этому стенду (второй стенд там не поднимается):

  curl -fsu '$GITEA_AGENT_USER:$GITEA_AGENT_PASSWORD' http://$host:13000/platform/internal-tools/raw/branch/main/infra/remote.sh \\
    | GITEA_AGENT_PASSWORD='$GITEA_AGENT_PASSWORD' sh -s -- $host $domain

Вернуть стенд только на это устройство: make local
EOF
    ;;
  local)
    unset_env SANDBOX_HOST
    unset_env SANDBOX_DOMAIN
    unset_env SANDBOX_BIND
    redeploy
    echo
    echo "Стенд доступен только с этого устройства: http://tools.localhost:18000"
    ;;
  *)
    die "команды: lan <host> [domain] | local"
    ;;
esac
