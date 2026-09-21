/**
 * /inbox — входящие человека: заглушка почтового ящика до подключения мессенджера или почты компании.
 * Уведомления платформы (простой, срок, потолок автопродления, упавшая выкатка, PR ждёт одобрения, превью убрано).
 */
import type { Message } from '../data.ts';
import { ago, badge, esc, layout } from '../html.ts';

const EVENT: Record<string, [string, string]> = {
  'tool.idle': ['bad', 'простой'], 'tool.expiring': ['warn', 'срок'], 'tool.ceiling': ['warn', 'автопродление'],
  'tool.reaped': ['bad', 'удалён'], 'deploy.failed': ['bad', 'выкатка'], 'pr.waiting': ['info', 'PR'], 'preview.dropped': ['info', 'превью'],
};

const FROM: Record<string, string> = { reaper: 'уборщик', deployer: 'деплоер' };

export function renderInbox(p: { actor: string; messages: Message[] | Error }): string {
  const list = p.messages instanceof Error ? [] : p.messages;
  const items = list.map((m) => {
    const [tone, label] = EVENT[m.event] ?? ['info', m.event];
    return `<div class="sx-card pt-tool"${m.read ? '' : ' style="border-color:var(--accent)"'}>
      <div class="pt-head"><h2>${m.link ? `<a href="${esc(m.link)}">${esc(m.subject)}</a>` : esc(m.subject)}</h2><span>${m.read ? '' : badge('info', 'новое')} ${badge(tone, label)}</span></div>
      <div class="pt-desc">${esc(m.text)}</div>
      <div class="sx-muted">${esc(ago(m.at))} · от ${esc(FROM[m.from] ?? m.from)}${m.note ? ` · ${esc(m.note)}` : ''}</div>
    </div>`;
  }).join('');
  return layout({
    title: 'Уведомления', active: 'inbox', actor: p.actor, errors: p.messages instanceof Error ? [p.messages] : [],
    lead: 'Что платформа сообщила вам за 90 дней. На стенде это почтовый ящик-заглушка; в компании те же сообщения придут в мессенджер или почту.',
    body: `<div class="pt-grid" style="grid-template-columns:1fr">${items || '<div class="sx-card sx-empty">Уведомлений нет</div>'}</div>`,
  });
}
