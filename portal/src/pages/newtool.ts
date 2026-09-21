/**
 * /new-tool — как подключить песочницу к своему агенту и собрать тул.
 *
 * Это единственное место, где человек узнаёт, что тул он заказывает не у разработчиков, а у своего агента:
 * MCP-сервер `sandbox` даёт агенту ровно те действия, которые песочница разрешает (реестр, скелет, проверка,
 * превью, PR) — и ничего сверх. Страница открыта всем вошедшим: тул может понадобиться кому угодно.
 */
import { DOMAIN, GITEA_PUBLIC, PUBLIC_PORT, REPO } from '../config.ts';
import { esc, layout } from '../html.ts';

const code = (text: string) => `<pre class="pt-code">${esc(text)}</pre>`;

/** Инструменты сервера `sandbox`: то же, что агент увидит у себя, теми же именами. */
const TOOLS: [string, string][] = [
  ['list_sources', 'какие источники и права записи одобрены — из них и собирается тул'],
  ['scaffold_tool', 'скелет тула: tool.yaml, действия, интерфейс; манифест сразу проверяется по реестру'],
  ['validate_manifest', 'проверка допуска: источники из реестра, срок в пределах лимита, круг доступа не шире источника'],
  ['deploy_preview', 'выкатить превью и получить ссылку, которую можно открыть и потрогать'],
  ['get_logs', 'логи тула и последней выкатки, если что-то не работает'],
  ['open_pull_request', 'PR в main: смотрите, одобряете и мержите вы — агент не может'],
  ['scaffold_connector, validate_connector', 'отдельная задача: подключение новой системы как источника'],
];

export function renderNewTool(p: { actor: string | null; tools: number }): string {
  const repo = `${GITEA_PUBLIC}/${REPO}`;
  const clone = `git clone ${repo}.git Sandbox && cd Sandbox && npm install`;

  const how = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Как это работает</h2></div>
    <ol class="pt-steps">
      <li><b>Вы ставите задачу своему агенту.</b> Словами: что за процесс, какие данные нужны, кто будет пользоваться.</li>
      <li><b>Агент собирает тул внутри рамок.</b> Он ходит только в песочницу: источники — из реестра, данные — через
        гейтвей, деплой и вход — из каркаса. Выйти за рамки он не может, поэтому согласовывать нечего.</li>
      <li><b>Вы смотрите превью и мержите PR.</b> Два решения человека на весь путь: одобрить источник в реестре
        (один раз, заранее) и посмотреть превью. Всё между ними — автоматика.</li>
    </ol>
    <div class="sx-muted">Сейчас в проде ${p.tools} тулов. Срок жизни у каждого свой: тул, которым перестали
      пользоваться, удаляется сам — поэтому пробовать не страшно.</div></div>`;

  const copy = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Шаг 1. Рабочая копия</h2>
      <span class="sx-muted">нужен Node ≥ 22.18</span></div>
    <div class="pt-sec"><b>На этом компьютере (где поднят стенд)</b>
      <div>Репозиторий уже есть — он и есть рабочая копия. Если ставите заново:</div>${code(clone)}</div>
    <div class="pt-sec"><b>На своём ноутбуке</b>
      <div>На компьютере со стендом выполните <code>make lan</code> — он откроет стенд в локальной сети и напечатает
        готовую строку для ноутбука. Она разворачивает рабочую копию (<code>infra/remote.sh</code>), подключённую
        к стенду: агент пишет тул у вас, а собирается и выкатывается тул на стенде.</div>
      <div class="sx-muted" style="margin-top:6px">В <code>.env</code> рабочей копии попадают только адрес стенда и
        учётка агента в Gitea — ни токенов гейтвея, ни паролей баз. Второй стенд там не поднимается.</div></div></div>`;

  const connect = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Шаг 2. Подключить сервер <code>sandbox</code></h2>
      <span class="sx-muted">одна команда на любой агент</span></div>
    <div class="pt-sec"><b>Claude Code</b>
      <div>Внутри репозитория сервер подхватывается сам из <code>.mcp.json</code> — при первом запуске подтвердите
        серверы проекта. Из другого каталога:</div>${code('claude mcp add sandbox -- <путь к репозиторию>/bin/sandbox-mcp platform')}</div>
    <div class="pt-sec"><b>Cursor</b><div>Конфиг уже в репозитории — <code>.cursor/mcp.json</code>; включите его в
      Settings → MCP.</div></div>
    <div class="pt-sec"><b>OpenCode</b><div>Конфиг в репозитории — <code>opencode.json</code>.</div></div>
    <div class="pt-sec"><b>Codex и другие хосты</b><div>Сервер stdio, команда та же:</div>
      ${code('<путь к репозиторию>/bin/sandbox-mcp platform')}</div>
    <div class="sx-notice">Конфиги агентов генерирует <code>make agents</code> — руками их не правят, иначе они
      разойдутся. Правила работы агент читает сам: они лежат в <code>AGENTS.md</code> репозитория.</div></div>`;

  const what = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Что агент сможет делать</h2>
      <span class="sx-muted">инструменты сервера <code>sandbox</code></span></div>
    <ul class="pt-list pt-defs">${TOOLS.map(([name, text]) => `<li><code>${esc(name)}</code><span class="sx-muted">${esc(text)}</span></li>`).join('')}</ul>
    <div class="sx-muted" style="margin-top:8px">У этого сервера нет доступа к данным и нет служебных токенов
      гейтвея: он только готовит код и просит выкатку. Превью выкатывает деплоер после зелёного CI — тех же
      проверок, что и для любого коммита.</div></div>`;

  const ask = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Шаг 3. Что сказать агенту</h2></div>
    <div>Достаточно задачи и четырёх уточнений — остальное он спросит сам:</div>
    ${code(`Собери тул в песочнице: <какой процесс он закрывает и что человек должен там делать>.
Данные: <что нужно видеть и что менять> — посмотри list_sources, чего не хватает, скажи.
Владелец: <логин>. Открыть: <группа или люди>. Срок: 30 дней.
Когда будет готово — deploy_preview и дай мне ссылку.`)}
    <div class="sx-muted">Дальше вы открываете превью, говорите, что поправить, и, когда всё нравится, агент
      делает <code>open_pull_request</code>. Одобряете и мержите PR вы — после мержа тул появляется на
      <a href="/">главной</a> и живёт на <code>&lt;тул&gt;.${esc(DOMAIN)}:${esc(PUBLIC_PORT)}</code>.</div></div>`;

  const limits = `<div class="sx-card pt-tool"><div class="pt-head"><h2>Рамки, о которые агент споткнётся</h2>
      <span class="sx-muted">их проверяет машина, а не договорённость</span></div>
    <ul class="pt-list pt-defs">
      <li><span>Источник не из <a href="/sources">реестра</a> — сборка падает</span>
        <span class="sx-muted">добавить источник решает его хранитель, а не тул</span></li>
      <li><span>Данные — только через гейтвей</span>
        <span class="sx-muted">драйверов баз и выхода в сеть у тула нет</span></li>
      <li><span>Запись — по явному праву и с решением человека</span>
        <span class="sx-muted">агент только готовит, применяет — человек</span></li>
      <li><span>Тул открыт кругу, а не всем вошедшим</span>
        <span class="sx-muted">и не шире, чем разрешил хранитель источника</span></li>
      <li><span>У тула есть срок жизни</span>
        <span class="sx-muted">простаивающий удаляется вместе с ресурсами</span></li>
      <li><span><code>main</code> защищён</span>
        <span class="sx-muted">мерж — только человеком, после зелёного CI</span></li>
    </ul></div>`;

  const ready = `<div class="sx-card pt-tool"><div class="pt-head"><h2>А готовый тул — в свой чат</h2></div>
    <div>Это другая связка: тул подключается к агенту как набор действий над данными
      (<code>sandbox-&lt;тул&gt;</code>). Команда и конфиги — на странице самого тула, в разделе «Подключить
      к агенту»; сначала один раз <code>bin/sandbox-mcp login</code>, чтобы агент ходил от вашего имени.</div>
    <div class="pt-actions"><a class="sx-btn" href="/">Каталог тулов</a><a class="sx-btn" href="/sources">Какие есть данные</a></div></div>`;

  return layout({
    title: 'Создать тул', active: 'new-tool', actor: p.actor,
    lead: 'Тул собирает ваш агент, а не очередь разработки: подключите песочницу к нему как MCP-сервер.',
    body: `<div class="pt-grid pt-read">${how}${copy}${connect}${what}${ask}${limits}${ready}</div>`,
  });
}
