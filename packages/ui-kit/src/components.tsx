import type { ComponentChildren, JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { boot, call, isApp } from './bridge.ts';

/** Выход — в сервисе личности песочницы: id.<домен>/logout. Хост тула отличается от него только первой меткой. */
function logoutUrl(): string {
  const host = typeof location === 'undefined' ? '' : location.host;
  const base = host.split('.').slice(1).join('.');
  return `http://id.${base || host}/logout?next=${encodeURIComponent(typeof location === 'undefined' ? '' : location.href)}`;
}

export function Page(props: { title?: string; subtitle?: string; children: ComponentChildren }) {
  return (
    <div class="sx-page">
      <div class="sx-header">
        <div>
          <h1>{props.title ?? boot.title}</h1>
          {props.subtitle && <p>{props.subtitle}</p>}
        </div>
        {!isApp && boot.actor && (
          <div class="sx-user">
            {boot.actor} · <a href={logoutUrl()}>выйти</a>
          </div>
        )}
      </div>
      <LifecycleBanner />
      {props.children}
    </div>
  );
}

interface Lifecycle {
  owner: string;
  /** Права записи, разрешённые этому человеку (шаг Б5): остальные кнопки тул может не показывать. */
  writes?: string[];
  /** Его группы — если тул хочет показать что-то только своим. */
  groups?: string[];
  /** Кто решает за владельца по справочнику (ушёл — руководитель, группа — участники). Старый гейтвей не присылает. */
  owners?: string[];
  owner_note?: string | null;
  expires_at: string;
  auto_extend_until: string | null;
  auto_extend_days: number;
  last_human_at: string | null;
  idle_notified_at: string | null;
  idle_revived_at: string | null;
  idle_days: number;
}

const DAY = 86_400_000;
const date = (s: string) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/**
 * Срок жизни тула (инвариант 4). Появляется сам, когда тул скоро удалится: истекает срок,
 * достигнут предел автопродления или был простой. Продлить или удалить может только владелец.
 */
export function LifecycleBanner() {
  const [lc, setLc] = useState<Lifecycle | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    call<Lifecycle>('lifecycle').then(setLc, () => undefined);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div class="sx-notice">{done}</div>;
  if (!lc) return null;
  const left = Math.ceil((new Date(lc.expires_at).getTime() - Date.now()) / DAY);
  const atCap = lc.auto_extend_until !== null && new Date(lc.expires_at).getTime() >= new Date(lc.auto_extend_until).getTime() - DAY;
  const revived = lc.idle_revived_at !== null && !lc.idle_notified_at;
  if (!lc.idle_notified_at && !revived && left > 7) return null;

  const isOwner = lc.owners ? lc.owners.includes(boot.actor ?? '') : boot.actor === lc.owner;
  const deciders = lc.owner_note ? `${lc.owner} (${lc.owner_note})` : lc.owner;
  if (revived && left > 7) {
    return (
      <div class="sx-confirm" style={{ marginBottom: '12px', borderColor: 'var(--warn)' }}>
        <div>
          <b>Тулом не пользовались больше {lc.idle_days} дней</b>, и он был назначен на удаление. Вы зашли — удаление
          отменено, тул продлён до {date(lc.expires_at)}.
        </div>
        {isOwner ? (
          confirmDelete ? (
            <div class="sx-row-actions">
              <span>Удалить тул сейчас? Отменить будет нельзя.</span>
              <Button variant="primary" disabled={busy} onClick={() => run(async () => {
                await call('lifecycle_delete');
                setDone('Тул отозван и будет удалён уборщиком в течение минуты.');
              })}>Да, удалить</Button>
              <Button disabled={busy} onClick={() => setConfirmDelete(false)}>Отмена</Button>
            </div>
          ) : (
            <div class="sx-row-actions">
              <Button variant="primary" onClick={() => setDone('Оставляем тул.')}>Оставить</Button>
              <Button disabled={busy} onClick={() => setConfirmDelete(true)}>Больше не нужен — удалить</Button>
            </div>
          )
        ) : (
          <div class="sx-muted">Решение об удалении — за владельцем: {deciders}.</div>
        )}
        <ErrorBox error={error} />
      </div>
    );
  }
  const why = lc.idle_notified_at
    ? `Тулом не пользовались ${lc.idle_days} дней.`
    : atCap
      ? 'Использование продлевало тул автоматически, но достигнут предел — нужно решение владельца.'
      : 'Подходит срок жизни тула.';

  return (
    <div class="sx-confirm" style={{ marginBottom: '12px', borderColor: 'var(--warn)' }}>
      <div>
        <b>Тул будет удалён {date(lc.expires_at)}</b>{left > 0 ? ` (через ${left} дн.)` : ''}. {why}
      </div>
      <div class="sx-muted">Данные в источниках останутся — удаляется только сам тул. Молчание считается отказом.</div>
      {isOwner ? (
        confirmDelete ? (
          <div class="sx-row-actions">
            <span>Удалить тул сейчас? Отменить будет нельзя.</span>
            <Button variant="primary" disabled={busy} onClick={() => run(async () => {
              await call('lifecycle_delete');
              setDone('Тул отозван и будет удалён уборщиком в течение минуты.');
            })}>Да, удалить</Button>
            <Button disabled={busy} onClick={() => setConfirmDelete(false)}>Отмена</Button>
          </div>
        ) : (
          <div class="sx-row-actions">
            <Button variant="primary" disabled={busy} onClick={() => run(async () => {
              const next = await call<Lifecycle>('lifecycle_extend');
              setDone(`Продлено до ${date(next.expires_at)}.`);
            })}>
              Продлить{lc.auto_extend_days ? ` на ${lc.auto_extend_days} дн.` : ''}
            </Button>
            <Button disabled={busy} onClick={() => setConfirmDelete(true)}>Удалить сейчас</Button>
          </div>
        )
      ) : (
        <div class="sx-muted">Продлить может владелец тула: {deciders}.</div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

export function Stats(props: { items: { label: string; value: string | number }[] }) {
  return (
    <div class="sx-stats">
      {props.items.map((s) => (
        <div class="sx-stat" key={s.label}>
          <b>{s.value}</b>
          <span>{s.label}</span>
        </div>
      ))}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export function Badge(props: { tone: Tone; children: ComponentChildren; title?: string }) {
  return (
    <span class={`sx-badge ${props.tone}`} title={props.title}>
      {props.children}
    </span>
  );
}

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'default'; active?: boolean }) {
  const { variant, active, class: _c, ...rest } = props;
  return <button type="button" {...rest} class={`sx-btn ${variant === 'primary' ? 'primary' : ''} ${active ? 'active' : ''}`} />;
}

export function Tabs<T extends string>(props: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div class="sx-tabs">
      {props.options.map((o) => (
        <Button key={o.value} active={o.value === props.value} onClick={() => props.onChange(o.value)}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export interface Column<Row> {
  key: string;
  title: string;
  num?: boolean;
  render: (row: Row) => ComponentChildren;
}

export function Table<Row>(props: { columns: Column<Row>[]; rows: Row[]; rowKey: (r: Row) => string | number; empty?: string }) {
  if (!props.rows.length) return <div class="sx-card sx-empty">{props.empty ?? 'Нет данных'}</div>;
  return (
    <div class="sx-card sx-table-wrap">
      <table class="sx-table">
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} class={c.num ? 'num' : ''}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={props.rowKey(r)}>
              {props.columns.map((c) => (
                <td key={c.key} class={c.num ? 'num' : ''}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ErrorBox(props: { error: string | null }) {
  return props.error ? <div class="sx-error">{props.error}</div> : null;
}

/** Вызов действия тула с состоянием загрузки. Работает одинаково в web и в MCP App. */
export function useAction<T>(action: string, input: Record<string, unknown> = {}) {
  const key = JSON.stringify(input);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    call<T>(action, JSON.parse(key))
      .then(setData, (e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [action, key]);

  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

export interface Prepared {
  confirmation_id: string;
  summary: string;
  /** Важное действие (confirm: true в реестре): применяется только после «Подтвердить» человеком. */
  confirm?: boolean;
}

export interface WriteDone {
  done: true;
  summary: string;
  [key: string]: unknown;
}

function isPrepared(v: unknown): v is Prepared {
  return Boolean(v && typeof v === 'object' && typeof (v as Prepared).confirmation_id === 'string');
}

const commit = async (p: Prepared): Promise<WriteDone> => {
  const committed = await call<WriteDone>('commit_write', { confirmation_id: p.confirmation_id });
  return { ...committed, summary: committed.summary ?? p.summary };
};

/**
 * Запись из UI: клик человека в форме и есть решение — применяется сразу (в web — apply; в MCP App действие
 * возвращает prepare, и UI сам вызывает commit_write). Исключение — важное действие (confirm в реестре):
 * возвращается Prepared, и человек подтверждает его отдельно. Агентский путь в чате — commit_approved.
 */
export async function writeAction(action: string, input: Record<string, unknown> = {}): Promise<WriteDone | Prepared> {
  const first = await call<Prepared | WriteDone>(action, input);
  if (!isPrepared(first)) return first as WriteDone;
  return first.confirm ? first : commit(first);
}

/**
 * Хук для форм записи: обычное действие — один клик; важное — ещё «Подтвердить» с описанием изменения.
 * Окно подтверждения рисует `view`, код тула для этого не меняется.
 */
/**
 * Что этому человеку разрешено записывать. Тул спрашивает один раз и прячет кнопки, которых ему не дадут;
 * решает всё равно гейтвей — он же проверит право на самой записи.
 */
let writesPromise: Promise<Lifecycle> | null = null;
export function useMyWrites(): { writes: string[] | null; groups: string[] } {
  const [state, setState] = useState<{ writes: string[] | null; groups: string[] }>({ writes: null, groups: [] });
  useEffect(() => {
    writesPromise ??= call<Lifecycle>('lifecycle');
    void writesPromise.then(
      (lc) => setState({ writes: lc.writes ?? null, groups: lc.groups ?? [] }),
      () => setState({ writes: null, groups: [] }),
    );
  }, []);
  return state;
}

export function useWrite(onDone: (summary: string, result: WriteDone) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Prepared | null>(null);
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = (action: string, input: Record<string, unknown>) =>
    guard(async () => {
      const result = await writeAction(action, input);
      if (isPrepared(result)) setPending(result);
      else onDone(result.summary, result);
    });
  const confirm = () =>
    guard(async () => {
      const result = await commit(pending!);
      setPending(null);
      onDone(result.summary, result);
    });
  const view = pending ? (
    <div class="sx-confirm">
      <div style={{ marginBottom: '4px' }}>{pending.summary}</div>
      <div class="sx-row-actions">
        <Button variant="primary" disabled={busy} onClick={() => void confirm()}>
          Подтвердить
        </Button>
        <Button disabled={busy} onClick={() => setPending(null)}>
          Отмена
        </Button>
      </div>
      <ErrorBox error={error} />
    </div>
  ) : (
    <ErrorBox error={error} />
  );
  return { run, busy, error, pending, view };
}

/**
 * Редкий случай, когда перед записью нужно текстовое обоснование (например, заметка к публикации).
 * После «Записать» изменение применяется сразу (web apply или prepare+commit в MCP App).
 */
export function ConfirmWrite(props: {
  label: string;
  defaultComment?: string;
  prepare: (comment: string) => Promise<Prepared | WriteDone>;
  onDone: (summary: string, result: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [comment, setComment] = useState(props.defaultComment ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const first = await props.prepare(comment.trim());
      const result = isPrepared(first)
        ? await call<WriteDone>('commit_write', { confirmation_id: first.confirmation_id })
        : (first as WriteDone);
      props.onDone(result.summary ?? (isPrepared(first) ? first.summary : ''), result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="sx-confirm">
      <div class="sx-muted" style={{ marginBottom: '4px' }}>
        {props.label}
      </div>
      <textarea rows={2} value={comment} onInput={(e) => setComment(e.currentTarget.value)} />
      <div class="sx-row-actions">
        <Button variant="primary" disabled={busy || !comment.trim()} onClick={() => void submit()}>
          Записать
        </Button>
        <Button disabled={busy} onClick={props.onCancel}>
          Отмена
        </Button>
      </div>
      <ErrorBox error={error} />
    </div>
  );
}
