/**
 * Уборщик: принудительная смертность тулов (инвариант 4).
 * Каждую минуту запускает проверку простоя (и тулов, за которых некому решать) и уборку истории (строки тулов,
 * отозванных больше недели назад),
 * сверяет контейнеры тулов с гейтвеем и удаляет всё,
 * что истекло, отозвано или не зарегистрировано. Молчание владельца считается отказом.
 * Владельцу — уведомления через сервис уведомлений: простой, скорое удаление, потолок автопродления, удаление.
 * Без npm-зависимостей: Docker API через unix-сокет.
 */
import http from 'node:http';

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://gateway:8080';
const REAPER_TOKEN = process.env.GATEWAY_REAPER_TOKEN;
const NOTIFIER_URL = process.env.NOTIFIER_URL ?? 'http://notifier:8080';
const NOTIFY_TOKEN = process.env.NOTIFY_REAPER_TOKEN ?? '';
const PORTAL_URL = process.env.PORTAL_URL ?? 'http://tools.localhost:18000';
const INTERVAL_MS = Number(process.env.REAPER_INTERVAL_SECONDS ?? 60) * 1000;
const WARN_DAYS = 3;
const CEILING_WARN_DAYS = 7;

interface Tool {
  name: string;
  owner: string;
  expires_at: string;
  revoked_at: string | null;
  auto_extend_until: string | null;
  last_human_at: string | null;
}
interface Container {
  Id: string;
  Image: string;
  Labels: Record<string, string>;
}

const log = (event: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));

function docker<T>(method: string, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '/var/run/docker.sock', path: `/v1.43${path}`, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400 && res.statusCode !== 404 && res.statusCode !== 304) {
          reject(new Error(`docker ${method} ${path}: ${res.statusCode} ${body}`));
        } else resolve((body ? JSON.parse(body) : null) as T);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
const toolLink = (name: string) => `${PORTAL_URL}/tools/${name}`;

/**
 * Сообщение владельцу через сервис уведомлений. Кому на самом деле (ушёл — руководителю, группа — участникам)
 * решает справочник. key — одно событие доставляется один раз, повторы на следующих циклах безопасны.
 * Уведомление не должно ломать уборку: ошибка — в лог, повтор на следующем цикле.
 */
async function notify(n: { to: string[]; event: string; key: string; subject: string; text: string; link: string }) {
  try {
    const res = await fetch(`${NOTIFIER_URL}/notify`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${NOTIFY_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(n),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  } catch (e) {
    log({ type: 'notify_failed', event: n.event, key: n.key, error: (e as Error).message });
  }
}

async function sweep() {
  // Простой: гейтвей помечает тулы без вызовов человека и укорачивает им срок до idle_grace_days.
  const idleRes = await fetch(`${GATEWAY_URL}/v1/admin/tools/sweep-idle`, { method: 'POST', headers: { Authorization: `Bearer ${REAPER_TOKEN}` } });
  if (!idleRes.ok) throw new Error(`гейтвей ответил ${idleRes.status} на проверку простоя`);
  const { idle } = (await idleRes.json()) as { idle: { name: string; owner: string; expires_at: string; last_human_at: string | null; reason: 'idle' | 'orphan' }[] };
  for (const t of idle) {
    log({ type: 'idle_notice', instance: t.name, owner: t.owner, reason: t.reason, last_human_at: t.last_human_at, delete_at: t.expires_at });
    await notify({
      to: [t.owner], event: 'tool.idle', key: `idle:${t.name}:${t.expires_at}`, link: toolLink(t.name),
      subject: t.reason === 'idle'
        ? `Тул ${t.name} простаивает и будет удалён ${date(t.expires_at)}`
        : `Тул ${t.name} остался без владельца и будет удалён ${date(t.expires_at)}`,
      text: t.reason === 'idle'
        ? `Людьми тул не пользовался ${t.last_human_at ? `с ${date(t.last_human_at)}` : 'ни разу'}. Если он ещё нужен — продлите его или просто зайдите в него. Молчание считается отказом: данные в источниках останутся, удалится только тул.`
        : `Владельца ${t.owner} нет в компании, и решать за него некому. Если тул нужен — продлите его и смените owner в tool.yaml через PR.`,
    });
  }

  // Уборка истории: строки тулов, отозванных или истёкших больше недели назад, — из гейтвея; аудит остаётся.
  const pruneRes = await fetch(`${GATEWAY_URL}/v1/admin/tools/prune`, { method: 'POST', headers: { Authorization: `Bearer ${REAPER_TOKEN}` } });
  if (!pruneRes.ok) throw new Error(`гейтвей ответил ${pruneRes.status} на уборку истории`);
  const { pruned } = (await pruneRes.json()) as { pruned: string[] };
  if (pruned.length) log({ type: 'pruned', instances: pruned });

  const res = await fetch(`${GATEWAY_URL}/v1/admin/tools`, { headers: { Authorization: `Bearer ${REAPER_TOKEN}` } });
  if (!res.ok) throw new Error(`гейтвей ответил ${res.status}`);
  const { tools } = (await res.json()) as { tools: Tool[] };
  const byName = new Map(tools.map((t) => [t.name, t]));

  const filters = encodeURIComponent(JSON.stringify({ label: ['sandbox.instance'] }));
  const containers = await docker<Container[]>('GET', `/containers/json?all=1&filters=${filters}`);
  const now = Date.now();

  for (const c of containers) {
    const instance = c.Labels['sandbox.instance']!;
    const t = byName.get(instance);
    const reason = !t
      ? 'не зарегистрирован в гейтвее'
      : t.revoked_at
        ? 'отозван'
        : new Date(t.expires_at).getTime() <= now
          ? `истёк TTL (${t.expires_at}), владелец ${t.owner} не продлил`
          : null;
    if (!reason) continue;

    await docker('DELETE', `/containers/${c.Id}?force=1`);
    await docker('DELETE', `/images/${encodeURIComponent(c.Image)}?force=1`).catch(() => undefined);
    log({ type: 'reaped', instance, reason });
    // Отзыв — чьё-то решение (владельца, админа, деплоера для превью); сообщаем только о том, что удалил срок.
    if (t && !t.revoked_at && !instance.includes('--')) {
      await notify({
        to: [t.owner], event: 'tool.reaped', key: `reaped:${instance}:${t.expires_at}`, link: toolLink(instance),
        subject: `Тул ${instance} удалён: истёк срок жизни`,
        text: `Срок закончился ${date(t.expires_at)}, продления не было. Данные в источниках остались. Код тула остаётся в main, пока его не уберут PR; выкатить заново — новый допуск через mcp-sandbox.`,
      });
    }
  }

  for (const t of tools) {
    if (t.revoked_at || t.name.includes('--')) continue;
    const left = new Date(t.expires_at).getTime() - now;
    if (left > 0 && left < WARN_DAYS * 86_400_000) {
      await notify({
        to: [t.owner], event: 'tool.expiring', key: `expiring:${t.name}:${t.expires_at}`, link: toolLink(t.name),
        subject: `Тул ${t.name} будет удалён ${date(t.expires_at)}`,
        text: 'Срок жизни подходит к концу. Если тул нужен — продлите его на главной или в самом туле.',
      });
    }
    // Потолок автопродления: заходы людей больше не продлевают тул — нужно явное решение владельца.
    const cap = t.auto_extend_until ? new Date(t.auto_extend_until).getTime() - now : Infinity;
    if (cap > 0 && cap < CEILING_WARN_DAYS * 86_400_000) {
      await notify({
        to: [t.owner], event: 'tool.ceiling', key: `ceiling:${t.name}:${t.auto_extend_until}`, link: toolLink(t.name),
        subject: `Тул ${t.name}: ${date(t.auto_extend_until!)} заканчивается автопродление`,
        text: 'Пока тулом пользуются, он продлевается сам, но не дальше этого срока от последнего явного продления. Продлите тул, если он ещё нужен, — иначе после этой даты он доживёт свой срок и будет удалён.',
      });
    }
  }
}

if (!REAPER_TOKEN) throw new Error('нет GATEWAY_REAPER_TOKEN');
log({ type: 'started', interval_seconds: INTERVAL_MS / 1000 });
const tick = () => sweep().catch((e: Error) => log({ type: 'error', error: e.message }));
void tick();
setInterval(tick, INTERVAL_MS);
