import type { WriteDef } from '@sandbox/manifest';
import { registry } from './config.ts';
import { audit } from './audit.ts';
import { connectorApply, connectorDescribe } from './connectors.ts';
import { service } from './db.ts';
import { badRequest, forbidden, notFound } from './errors.ts';
import type { CallContext } from './context.ts';

/**
 * Запись — общая для всех источников: право из реестра, объявлено в манифесте, параметры по схеме реестра, важное —
 * с подтверждением, агент — только с согласием человека, всё в аудите. Как именно записать и как сказать человеку,
 * что изменится, знает коннектор источника (describe/apply). Кода источников в гейтвее нет.
 */
type Params = Record<string, string | number>;

/** Сформулировать запись для человека — коннектор источника; данные не меняются. */
function describeWrite(writeId: string, def: WriteDef, params: Params): Promise<string> {
  return connectorDescribe(registry.sources[def.source]!, def.source, writeId, params);
}

/** Выполнить запись. by — кто решил и какой агент готовил; коннектор получает то же для своего журнала. */
function applyWriteTo(writeId: string, def: WriteDef, params: Params, by: { decidedBy: string; agent: string | null }) {
  return connectorApply(registry.sources[def.source]!, def.source, writeId, params, by);
}

/**
 * Кому разрешено это право записи (шаг Б5). В манифесте право можно ограничить группами:
 * «менять остатки может только склад». Кнопку остальным не показываем, но решает всё равно гейтвей.
 */
function checkWriteGroups(ctx: CallContext, writeId: string): void {
  const groups = ctx.manifest.write_groups[writeId] ?? [];
  if (!groups.length || groups.some((g) => ctx.groups.includes(g))) return;
  throw forbidden(`право «${writeId}» в туле ${ctx.tool} разрешено группам: ${groups.join(', ')}. Доступ даёт владелец тула`);
}

function validateParams(def: WriteDef, raw: unknown): Params {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw badRequest('params должен быть объектом');
  const input = raw as Record<string, unknown>;
  const out: Params = {};
  const extra = Object.keys(input).filter((k) => !(k in def.params));
  if (extra.length) throw badRequest(`неизвестные параметры: ${extra.join(', ')}`);

  for (const [name, spec] of Object.entries(def.params)) {
    const v = input[name];
    if (v === undefined || v === '') {
      if (spec.required) throw badRequest(`параметр ${name} обязателен`);
      continue;
    }
    if (spec.type === 'integer' && !Number.isInteger(v)) throw badRequest(`${name}: ожидается целое число`);
    if (spec.type === 'string' && typeof v !== 'string') throw badRequest(`${name}: ожидается строка`);
    if (spec.type === 'enum' && !spec.values.includes(v as string)) {
      throw badRequest(`${name}: допустимо ${spec.values.join(' | ')}`);
    }
    out[name] = v as string | number;
  }
  return out;
}

/** Шаг 1: подготовить запись. Может агент. Данные не меняются. */
export async function prepareWrite(ctx: CallContext, writeId: string, rawParams: unknown) {
  const base = { requestId: ctx.requestId, actor: ctx.actor, tool: ctx.tool, source: writeId, agentInChain: ctx.agent !== null };
  const operation = 'write.prepare';
  const deny = async (err: Error) => {
    await audit({ ...base, operation, allowed: false, reason: err.message });
    return err;
  };

  const def = registry.writes[writeId];
  if (!def) throw await deny(notFound(`право на запись «${writeId}» не найдено в реестре`));
  if (!ctx.manifest.writes.includes(writeId)) {
    throw await deny(forbidden(`право на запись «${writeId}» не объявлено в tool.yaml тула ${ctx.tool}`));
  }

  let params: Params;
  let summary: string;
  try {
    checkWriteGroups(ctx, writeId);
    params = validateParams(def, rawParams);
    summary = await describeWrite(writeId, def, params);
  } catch (e) {
    throw await deny(e as Error);
  }

  await audit({ ...base, operation, fields: Object.keys(params), allowed: true });
  const { rows } = await service.query<{ id: string; expires_at: Date }>(
    `INSERT INTO gateway.pending_writes (tool, write_id, params, summary, prepared_by, agent_in_chain, agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))
     RETURNING id, expires_at`,
    [ctx.tool, writeId, params, summary, ctx.actor, ctx.agent !== null, ctx.agent, registry.policy.write_confirmation_ttl_seconds],
  );
  const prepared = { confirmation_id: rows[0]!.id, summary, expires_at: rows[0]!.expires_at, confirm: def.confirm };
  if (ctx.agent === null) return { ...prepared, requires: 'подтверждение человеком в интерфейсе (commit_write)' };
  // Агенту — прямое указание: изменение не применено, решает человек в чате.
  return {
    ...prepared,
    requires: 'согласие человека в чате',
    next: `Изменение НЕ применено. Покажи человеку summary дословно и спроси, применить ли. ` +
      `Только после явного согласия вызови commit_approved { confirmation_id, approval: <его ответ дословно> }. ` +
      `Не согласен или молчит — не вызывай; подтверждение истечёт само.`,
  };
}

/**
 * Сразу применить запись. Только человек без агента (web UI): клик в форме и есть решение.
 * Важное действие (confirm: true в реестре) не применяется сразу: возвращается summary, и UI просит «Подтвердить».
 * Агентский путь — prepare → согласие человека в чате → commit_approved.
 */
export async function applyWrite(ctx: CallContext, writeId: string, rawParams: unknown) {
  const base = { requestId: ctx.requestId, actor: ctx.actor, tool: ctx.tool, source: writeId, agentInChain: ctx.agent !== null };
  const operation = 'write.apply';
  const deny = async (err: Error) => {
    await audit({ ...base, operation, allowed: false, reason: err.message });
    return err;
  };

  if (ctx.agent !== null) {
    throw await deny(forbidden('агент не может записать сразу: подготовьте, покажите summary человеку и после его согласия — commit_approved'));
  }

  const def = registry.writes[writeId];
  if (!def) throw await deny(notFound(`право на запись «${writeId}» не найдено в реестре`));
  if (!ctx.manifest.writes.includes(writeId)) {
    throw await deny(forbidden(`право на запись «${writeId}» не объявлено в tool.yaml тула ${ctx.tool}`));
  }
  try {
    checkWriteGroups(ctx, writeId);
  } catch (e) {
    throw await deny(e as Error);
  }
  if (def.confirm) return prepareWrite(ctx, writeId, rawParams);

  let params: Params;
  let summary: string;
  try {
    params = validateParams(def, rawParams);
    summary = await describeWrite(writeId, def, params);
  } catch (e) {
    throw await deny(e as Error);
  }

  // Аудит до записи: не смогли записать аудит — запись не выполняется.
  await audit({ ...base, operation, fields: Object.keys(params), allowed: true });
  const result = await applyWriteTo(writeId, def, params, { decidedBy: ctx.actor, agent: null });
  return { done: true, summary, committed_by: ctx.actor, ...result };
}

/**
 * Шаг 2: применить подготовленную запись.
 *   Человек (интерфейс тула, commit_write) — любую подготовленную для этого тула.
 *   Агент (commit_approved) — только подготовленную агентом и только с согласием человека из чата (approval):
 *   его ответ дословно попадает в аудит, а в аудите честно отмечено, что агент в цепочке.
 */
export async function commitWrite(ctx: CallContext, confirmationId: string, approval?: unknown) {
  const byAgent = ctx.agent !== null;
  const approvalText = typeof approval === 'string' ? approval.trim().slice(0, 300) : '';
  const base = { requestId: ctx.requestId, actor: ctx.actor, tool: ctx.tool, agentInChain: byAgent };
  const operation = byAgent ? 'write.commit_approved' : 'write.commit';
  const deny = async (err: Error, source?: string) => {
    await audit({ ...base, source, operation, allowed: false, reason: err.message });
    return err;
  };

  if (byAgent && approvalText.length < 2) {
    throw await deny(badRequest('нужно approval — согласие человека из чата дословно. Без согласия запись не применяется'));
  }

  // Атомарно забираем подтверждение, чтобы его нельзя было применить дважды.
  // Агенту — только подготовленное агентом: запись, подготовленную человеком в UI, решает человек в UI.
  const { rows } = await service.query<{ write_id: string; params: Params; summary: string; agent: string | null }>(
    `UPDATE gateway.pending_writes SET committed_at = now(), committed_by = $3
      WHERE id = $1 AND tool = $2 AND committed_at IS NULL AND expires_at > now() AND ($4 = false OR agent_in_chain)
      RETURNING write_id, params, summary, agent`,
    [confirmationId, ctx.tool, ctx.actor, byAgent],
  ).catch(() => ({ rows: [] }));
  const pending = rows[0];
  if (!pending) throw await deny(notFound('подтверждение не найдено, уже использовано, истекло или подготовлено не агентом'));

  const def = registry.writes[pending.write_id]!;
  if (!ctx.manifest.writes.includes(pending.write_id)) {
    throw await deny(forbidden(`право «${pending.write_id}» больше не объявлено в tool.yaml`), pending.write_id);
  }
  // Группы могли измениться между подготовкой и подтверждением — проверяем ещё раз, на самом решении.
  try {
    checkWriteGroups(ctx, pending.write_id);
  } catch (e) {
    await service.query('UPDATE gateway.pending_writes SET committed_at = NULL, committed_by = NULL WHERE id = $1', [confirmationId]);
    throw await deny(e as Error, pending.write_id);
  }

  await audit({
    ...base, source: pending.write_id, operation, fields: Object.keys(pending.params), allowed: true,
    reason: byAgent ? `согласие человека в чате: «${approvalText}»` : undefined,
  });
  let result: Record<string, unknown> | void;
  try {
    result = await applyWriteTo(pending.write_id, def, pending.params, { decidedBy: ctx.actor, agent: pending.agent });
  } catch (e) {
    await service.query('UPDATE gateway.pending_writes SET committed_at = NULL, committed_by = NULL WHERE id = $1', [confirmationId]);
    throw e;
  }
  return { done: true, summary: pending.summary, committed_by: ctx.actor, ...result };
}
